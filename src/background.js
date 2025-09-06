// constants
const INSET = 5;
let GAP = 3;
let ADDRESS_BAR_HEIGHT = 40;

/**
 * Controller state associated with a newly created blank tab.
 * Keys are controller blank tab ids; values store popup windows and parent window.
 * @type {Map<number, { parentWindowId: number, popupWindowIds: number[], controllerTabIndex: number, controllerTabGroupId: number, widthRatios: Record<number, number> }>}
 */
const controllerByTabId = new Map();

/**
 * Reverse lookup from popup window id to controller tab id.
 * @type {Map<number, number>}
 */
const popupWindowIdToControllerTabId = new Map();

/**
 * Track window ids we are updating programmatically to avoid re-entrant tiling.
 * @type {Set<number>}
 */
const programmaticUpdateWindowIds = new Set();

/**
 * Track the last focused window to detect focus transitions.
 * @type {number | null}
 */
let lastFocusedWindowId = null;

// Key to store controllers state in session storage
const STORAGE_KEY_CONTROLLERS = 'sandwichBear.controllers';

// Ensure we only attempt a restore once per service worker lifecycle
let hasRestoredControllers = false;

/**
 * Persist current controllers to session storage so association survives
 * service worker restarts within the same browser session.
 */
const persistControllers = async () => {
  try {
    /** @type {{controllerTabId:number,parentWindowId:number,popupWindowIds:number[],controllerTabIndex:number,controllerTabGroupId:number,widthRatios:Record<number, number>}[]} */
    const controllers = [...controllerByTabId.entries()].map(
      ([controllerTabId, ctl]) => ({ controllerTabId, ...ctl }),
    );
    await chrome.storage.session.set({
      [STORAGE_KEY_CONTROLLERS]: controllers,
    });
  } catch (_e) {}
};

/**
 * Restore controllers from session storage. Prunes stale tabs/windows.
 */
const restoreControllers = async () => {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEY_CONTROLLERS);
    /** @type {any[]} */
    const saved = Array.isArray(data?.[STORAGE_KEY_CONTROLLERS])
      ? data[STORAGE_KEY_CONTROLLERS]
      : [];

    controllerByTabId.clear();
    popupWindowIdToControllerTabId.clear();

    for (const item of saved) {
      const controllerTabId = Number(item?.controllerTabId);
      if (!Number.isFinite(controllerTabId)) continue;
      // Verify controller tab still exists
      let tabExists = false;
      try {
        const t = await chrome.tabs.get(controllerTabId);
        tabExists = !!t && typeof t.id === 'number';
      } catch (_e) {
        tabExists = false;
      }
      if (!tabExists) continue;

      // Filter popup windows that still exist
      const popupIds = Array.isArray(item?.popupWindowIds)
        ? item.popupWindowIds
        : [];
      /** @type {number[]} */
      const existingPopupIds = [];
      for (const winId of popupIds) {
        try {
          const w = await chrome.windows.get(winId);
          if (w && typeof w.id === 'number') existingPopupIds.push(winId);
        } catch (_e) {}
      }
      if (existingPopupIds.length === 0) continue;

      // Rebuild width ratios only for existing popups
      /** @type {Record<number, number>} */
      const widthRatios = {};
      const rawRatios = item?.widthRatios || {};
      const ratios = existingPopupIds.map((id) => Number(rawRatios[id] || 0));
      const sum =
        ratios.reduce((s, r) => s + (Number.isFinite(r) ? r : 0), 0) || 1;
      for (let i = 0; i < existingPopupIds.length; i++) {
        widthRatios[existingPopupIds[i]] =
          Math.max(0, Number.isFinite(ratios[i]) ? ratios[i] : 0) / sum;
      }

      controllerByTabId.set(controllerTabId, {
        parentWindowId: Number(item?.parentWindowId) || -1,
        popupWindowIds: existingPopupIds,
        controllerTabIndex: Number(item?.controllerTabIndex) || 0,
        controllerTabGroupId: Number(item?.controllerTabGroupId) || -1,
        widthRatios,
      });
      for (const winId of existingPopupIds) {
        popupWindowIdToControllerTabId.set(winId, controllerTabId);
      }
    }
  } catch (_e) {
    // ignore
  }
};

/**
 * Ensure controllers have been restored from storage once in this lifecycle.
 */
const ensureRestoredControllers = async () => {
  if (hasRestoredControllers) return;
  hasRestoredControllers = true;
  await restoreControllers();
  try {
    const os = await getPlatformOs();
    if (os === 'win') {
      ADDRESS_BAR_HEIGHT = 50;
      GAP = 0;
    }
  } catch (_e) {}
};

/**
 * Get and cache the platform OS (e.g., 'win', 'mac', 'linux').
 * @returns {Promise<string>}
 */
let cachedPlatformOs = null;
const getPlatformOs = async () => {
  if (cachedPlatformOs) return cachedPlatformOs;
  try {
    const info = await chrome.runtime.getPlatformInfo();
    cachedPlatformOs = info?.os || 'unknown';
  } catch (_e) {
    cachedPlatformOs = 'unknown';
  }
  return cachedPlatformOs;
};

/**
 * Focus the first popup window of the given controller to bring popups to front.
 * @param {number} controllerTabId
 */
const focusFirstPopupWindow = async (controllerTabId) => {
  try {
    const ctl = controllerByTabId.get(controllerTabId);
    if (
      !ctl ||
      !Array.isArray(ctl.popupWindowIds) ||
      ctl.popupWindowIds.length === 0
    )
      return;
    // If the parent window is minimized, do not alter popup focus/state
    try {
      const parentWin = await chrome.windows.get(ctl.parentWindowId);
      if (parentWin?.state === 'minimized') return;
    } catch (_e) {}
    const firstPopupId = ctl.popupWindowIds[0];

    // On Windows, focusing only one popup can leave others behind the parent.
    // Workaround: briefly focus each popup to lift them above the parent,
    // then refocus the first popup for consistent UX.
    const os = await getPlatformOs();
    if (os === 'win') {
      for (const winId of ctl.popupWindowIds) {
        if (typeof winId === 'number') {
          try {
            await chrome.windows.update(winId, { focused: true });
          } catch (_e) {
            // ignore per-window failures
          }
        }
      }
      if (typeof firstPopupId === 'number') {
        await chrome.windows.update(firstPopupId, { focused: true });
      }
    } else {
      if (typeof firstPopupId === 'number') {
        await chrome.windows.update(firstPopupId, { focused: true });
      }
    }
  } catch (_e) {
    // ignore
  }
};

/**
 * Debounce timers per controller to avoid excessive re-tiles while dragging.
 * @type {Map<number, number>}
 */
const retileTimeoutByController = new Map();

/**
 * Hide all popup windows for a given controller tab id (minimize them).
 * @param {number} controllerTabId
 */
const hideControllerPopups = async (controllerTabId) => {
  // DO NOTHING, just let the parent window cover on top of the popup windows
};

/**
 * Minimize all popup windows for a given controller tab id.
 * @param {number} controllerTabId
 */
const minimizeControllerPopups = async (controllerTabId) => {
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;

  for (const winId of controller.popupWindowIds) {
    try {
      await chrome.windows.update(winId, { state: 'minimized' });
    } catch (_e) {
      // window may already be closed/minimized
    }
  }
};

/**
 * Compute and apply tiling for popup windows alongside their parent window bounds.
 * This also restores them to normal (visible) state.
 * @param {number} controllerTabId
 */
const tileControllerPopups = async (controllerTabId) => {
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;
  try {
    // Keep controller info up to date with any tab moves/group changes
    await refreshControllerFromTab(controllerTabId);

    const parentWindow = await chrome.windows.get(controller.parentWindowId);
    const windowWidth = parentWindow.width || 0;
    const windowHeight = parentWindow.height || 0;
    const windowTop = parentWindow.top || 0;
    const windowLeft = parentWindow.left || 0;

    const count = Math.max(1, controller.popupWindowIds.length);
    const availableWidth = Math.max(0, windowWidth - INSET - INSET);
    const availableHeight = Math.max(
      0,
      windowHeight - ADDRESS_BAR_HEIGHT - INSET,
    );
    const totalGaps = Math.max(0, (count - 1) * GAP);
    const availableWidthNoGaps = Math.max(0, availableWidth - totalGaps);
    const baseColumnWidth = Math.floor(availableWidthNoGaps / count);

    await Promise.all(
      controller.popupWindowIds.map(async (winId, i) => {
        try {
          const isLast = i === count - 1;
          const columnLeft = windowLeft + INSET + i * (baseColumnWidth + GAP);
          const columnWidth = isLast
            ? availableWidthNoGaps - baseColumnWidth * i
            : baseColumnWidth;
          programmaticUpdateWindowIds.add(winId);
          try {
            await chrome.windows.update(winId, {
              state: 'normal',
              left: columnLeft,
              top: windowTop + ADDRESS_BAR_HEIGHT,
              width: Math.max(50, columnWidth),
              height: Math.max(100, availableHeight),
            });
          } finally {
            setTimeout(() => programmaticUpdateWindowIds.delete(winId), 100);
          }
        } catch (_e) {
          // ignore if window was removed or cannot be updated
        }
      }),
    );
  } catch (_e) {
    // parent window may be gone
  }
};

/**
 * Reflow sibling popups after one popup is resized/moved by the user.
 * Rules:
 * - If the resized popup exceeds the parent window's rect, expand the parent to contain it
 * - Popups to the left share the left side equally
 * - Popups to the right share the right side equally
 * - All popups' heights match the parent's available height
 * @param {number} controllerTabId
 * @param {number} resizedPopupWindowId
 */
const reflowAfterPopupResize = async (
  controllerTabId,
  resizedPopupWindowId,
) => {
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;
  try {
    await refreshControllerFromTab(controllerTabId);

    // Resolve current parent bounds
    const parentWindow = await chrome.windows.get(controller.parentWindowId);
    if (!parentWindow) return;
    let parentLeft = parentWindow.left || 0;
    let parentTop = parentWindow.top || 0;
    let parentWidth = parentWindow.width || 0;
    let parentHeight = parentWindow.height || 0;

    // Get all popup bounds
    /** @type {{id:number,left:number,top:number,width:number,height:number}[]} */
    const popups = [];
    for (const winId of controller.popupWindowIds) {
      try {
        const w = await chrome.windows.get(winId);
        if (!w) continue;
        popups.push({
          id: winId,
          left: w.left || 0,
          top: w.top || 0,
          width: w.width || 0,
          height: w.height || 0,
        });
      } catch (_e) {}
    }
    if (popups.length === 0) return;

    // Identify resized popup info
    const resized = popups.find((p) => p.id === resizedPopupWindowId);
    if (!resized) return;

    // Get screen info to clamp popup resizing/movement
    const displays = await chrome.system.display.getInfo({});
    if (!displays || displays.length === 0) return;
    const parentCenterX = parentLeft + parentWidth / 2;
    const parentCenterY = parentTop + parentHeight / 2;
    let display = displays.find((d) => {
      const area = d.workArea;
      return (
        parentCenterX >= area.left &&
        parentCenterX < area.left + area.width &&
        parentCenterY >= area.top &&
        parentCenterY < area.top + area.height
      );
    });
    if (!display) {
      display = displays.find((d) => d.isPrimary) || displays[0];
    }
    const screen = display.workArea;

    // Clamp the resized popup to be within the screen's work area
    resized.width = Math.max(50, Math.min(resized.width, screen.width));
    resized.height = Math.max(100, Math.min(resized.height, screen.height));
    resized.left = Math.max(
      screen.left,
      Math.min(resized.left, screen.left + screen.width - resized.width),
    );
    resized.top = Math.max(
      screen.top,
      Math.min(resized.top, screen.top + screen.height - resized.height),
    );

    // Use the parent's inner top (below address bar) to align sibling popups
    const topForPopups = Math.max(screen.top, parentTop + ADDRESS_BAR_HEIGHT);
    const availableHeight = resized.height;

    // Sort by left for deterministic ordering
    popups.sort((a, b) => a.left - b.left);
    const idx = popups.findIndex((p) => p.id === resizedPopupWindowId);
    if (idx < 0) return;
    const leftGroup = popups.slice(0, idx);
    const rightGroup = popups.slice(idx + 1);

    // Use the screen-clamped values for the resized popup
    const parentInnerLeft = parentLeft + INSET;
    const parentInnerRight = parentLeft + parentWidth - INSET;
    let resizedLeftClamped = resized.left;
    let resizedWidthClamped = resized.width;

    // Left region: from inner-left to (resizedLeftClamped - GAP)
    const leftRegionStart = parentInnerLeft;
    const leftRegionEnd = Math.max(
      leftRegionStart,
      resizedLeftClamped - (leftGroup.length > 0 ? GAP : 0),
    );
    const leftRegionWidth = Math.max(0, leftRegionEnd - leftRegionStart);
    const leftGaps = Math.max(0, (leftGroup.length - 1) * GAP);
    const leftWidthNoGaps = Math.max(0, leftRegionWidth - leftGaps);
    const leftBaseWidth =
      leftGroup.length > 0 ? Math.floor(leftWidthNoGaps / leftGroup.length) : 0;

    // Right region: from (resizedRight + GAP) to inner-right
    const resizedRightClamped = resizedLeftClamped + resizedWidthClamped;
    const rightRegionStart = Math.min(
      parentInnerRight,
      resizedRightClamped + (rightGroup.length > 0 ? GAP : 0),
    );
    const rightRegionEnd = parentInnerRight;
    const rightRegionWidth = Math.max(0, rightRegionEnd - rightRegionStart);
    const rightGaps = Math.max(0, (rightGroup.length - 1) * GAP);
    const rightWidthNoGaps = Math.max(0, rightRegionWidth - rightGaps);
    const rightBaseWidth =
      rightGroup.length > 0
        ? Math.floor(rightWidthNoGaps / rightGroup.length)
        : 0;

    // Issue updates: left group
    let cursor = leftRegionStart;
    for (let i = 0; i < leftGroup.length; i++) {
      const isLast = i === leftGroup.length - 1;
      const width =
        leftGroup.length > 0
          ? isLast
            ? Math.max(0, leftWidthNoGaps - leftBaseWidth * i)
            : leftBaseWidth
          : 0;
      const target = leftGroup[i];
      programmaticUpdateWindowIds.add(target.id);
      try {
        await chrome.windows.update(target.id, {
          state: 'normal',
          left: cursor,
          top: topForPopups,
          width: Math.max(50, width),
          height: availableHeight,
        });
      } catch (_e) {
      } finally {
        setTimeout(() => programmaticUpdateWindowIds.delete(target.id), 100);
      }
      cursor += Math.max(50, width) + GAP;
    }

    // Update the resized popup itself
    programmaticUpdateWindowIds.add(resizedPopupWindowId);
    try {
      await chrome.windows.update(resizedPopupWindowId, {
        state: 'normal',
        left: resizedLeftClamped,
        top: topForPopups,
        width: Math.max(50, resizedWidthClamped),
        height: availableHeight,
      });
    } catch (_e) {
    } finally {
      setTimeout(
        () => programmaticUpdateWindowIds.delete(resizedPopupWindowId),
        100,
      );
    }

    // Issue updates: right group
    cursor = rightRegionStart;
    for (let i = 0; i < rightGroup.length; i++) {
      const isLast = i === rightGroup.length - 1;
      const width =
        rightGroup.length > 0
          ? isLast
            ? Math.max(0, rightWidthNoGaps - rightBaseWidth * i)
            : rightBaseWidth
          : 0;
      const target = rightGroup[i];
      programmaticUpdateWindowIds.add(target.id);
      try {
        await chrome.windows.update(target.id, {
          state: 'normal',
          left: cursor,
          top: topForPopups,
          width: Math.max(50, width),
          height: availableHeight,
        });
      } catch (_e) {
      } finally {
        setTimeout(() => programmaticUpdateWindowIds.delete(target.id), 100);
      }
      cursor += Math.max(50, width) + GAP;
    }

    // Update width ratios based on new layout
    try {
      const totalWidth =
        leftWidthNoGaps + resizedWidthClamped + rightWidthNoGaps;
      if (totalWidth > 0) {
        // Update ratios for left group
        for (let i = 0; i < leftGroup.length; i++) {
          const isLast = i === leftGroup.length - 1;
          const width =
            leftGroup.length > 0
              ? isLast
                ? Math.max(0, leftWidthNoGaps - leftBaseWidth * i)
                : leftBaseWidth
              : 0;
          controller.widthRatios[leftGroup[i].id] =
            Math.max(0, width) / totalWidth;
        }

        // Update ratio for resized popup
        controller.widthRatios[resizedPopupWindowId] =
          Math.max(0, resizedWidthClamped) / totalWidth;

        // Update ratios for right group
        for (let i = 0; i < rightGroup.length; i++) {
          const isLast = i === rightGroup.length - 1;
          const width =
            rightGroup.length > 0
              ? isLast
                ? Math.max(0, rightWidthNoGaps - rightBaseWidth * i)
                : rightBaseWidth
              : 0;
          controller.widthRatios[rightGroup[i].id] =
            Math.max(0, width) / totalWidth;
        }
      }
    } catch (_e) {
      // ignore ratio update errors
    }
  } catch (_e) {
    // ignore
  }
};

/**
 * Apply proportional layout based on stored width ratios.
 * @param {number} controllerTabId
 */
const applyProportionalLayout = async (controllerTabId) => {
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;
  try {
    await refreshControllerFromTab(controllerTabId);

    const parentWindow = await chrome.windows.get(controller.parentWindowId);
    // If the parent window is minimized, ensure popups stay minimized and skip layout
    if (parentWindow?.state === 'minimized') {
      await Promise.all(
        controller.popupWindowIds.map(async (winId) => {
          try {
            await chrome.windows.update(winId, { state: 'minimized' });
          } catch (_e) {}
        }),
      );
      return;
    }
    const windowWidth = parentWindow.width || 0;
    const windowHeight = parentWindow.height || 0;
    const windowTop = parentWindow.top || 0;
    const windowLeft = parentWindow.left || 0;

    const count = Math.max(1, controller.popupWindowIds.length);
    const availableWidth = Math.max(0, windowWidth - INSET - INSET);
    const availableHeight = Math.max(
      0,
      windowHeight - ADDRESS_BAR_HEIGHT - INSET,
    );
    const totalGaps = Math.max(0, (count - 1) * GAP);
    const availableWidthNoGaps = Math.max(0, availableWidth - totalGaps);

    // Get ratios for each popup, defaulting to equal distribution
    const defaultRatio = count > 0 ? 1 / count : 1;
    const ratios = controller.popupWindowIds.map((winId) => {
      const ratio = controller.widthRatios[winId];
      return typeof ratio === 'number' && isFinite(ratio) && ratio > 0
        ? ratio
        : defaultRatio;
    });

    // Normalize ratios to sum to 1
    const ratioSum = ratios.reduce((sum, ratio) => sum + ratio, 0) || 1;
    const normalizedRatios = ratios.map((ratio) => ratio / ratioSum);

    // Calculate widths based on ratios
    const widths = normalizedRatios.map((ratio) =>
      Math.max(50, Math.floor(availableWidthNoGaps * ratio)),
    );

    // Distribute any remaining width to the last popup
    const usedWidth = widths
      .slice(0, -1)
      .reduce((sum, width) => sum + width, 0);
    if (widths.length > 0) {
      widths[widths.length - 1] = Math.max(
        50,
        availableWidthNoGaps - usedWidth,
      );
    }

    // Calculate positions for each popup
    const positions = [];
    let cursor = windowLeft + INSET;
    for (let i = 0; i < controller.popupWindowIds.length; i++) {
      const width = widths[i];
      positions.push({
        winId: controller.popupWindowIds[i],
        left: cursor,
        width: width,
      });
      cursor += width + GAP;
    }

    // Apply the layout
    await Promise.all(
      positions.map(async ({ winId, left, width }) => {
        try {
          programmaticUpdateWindowIds.add(winId);
          try {
            await chrome.windows.update(winId, {
              state: 'normal',
              left: left,
              top: windowTop + ADDRESS_BAR_HEIGHT,
              width: width,
              height: Math.max(100, availableHeight),
            });
          } finally {
            setTimeout(() => programmaticUpdateWindowIds.delete(winId), 100);
          }
        } catch (_e) {
          // ignore if window was removed or cannot be updated
        }
      }),
    );
  } catch (_e) {
    // parent window may be gone
  }
};

/**
 * Ensure only the active controller's popups are visible; others are hidden.
 * @param {number} activeControllerTabId
 */
const showOnlyActiveController = async (activeControllerTabId) => {
  const allControllers = [...controllerByTabId.keys()];
  await Promise.all(
    allControllers.map(async (tabId) => {
      if (tabId === activeControllerTabId) {
        // If the parent window is minimized, keep popups minimized
        try {
          const ctl = controllerByTabId.get(tabId);
          if (ctl) {
            const parent = await chrome.windows.get(ctl.parentWindowId);
            if (parent?.state === 'minimized') {
              await minimizeControllerPopups(tabId);
              return;
            }
          }
        } catch (_e) {}
        await applyProportionalLayout(tabId);
      } else {
        await hideControllerPopups(tabId);
      }
    }),
  );
};

/**
 * Clean up controller state and reverse indices.
 * @param {number} controllerTabId
 */
const cleanupController = (controllerTabId) => {
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;
  for (const winId of controller.popupWindowIds) {
    popupWindowIdToControllerTabId.delete(winId);
  }
  controllerByTabId.delete(controllerTabId);
};

/**
 * Post a message into the controller tab to update its title/favicon.
 * @param {number} controllerTabId
 * @param {{ title?: string, favicon?: string } | null} metaOrNull
 */
const postControllerMeta = async (controllerTabId, metaOrNull) => {
  try {
    // Ensure the tab still exists
    await chrome.tabs.get(controllerTabId);
  } catch (e) {
    console.error('Failed to post controller meta:', e);
    return;
  }
  let message;
  if (metaOrNull) {
    message = { type: 'split:updateMeta', payload: metaOrNull };
  } else {
    /** @type {string[]} */
    const titles = [];
    try {
      const ctl = controllerByTabId.get(controllerTabId);
      if (ctl) {
        for (const winId of ctl.popupWindowIds) {
          try {
            const win = await chrome.windows.get(winId, { populate: true });
            const t = win.tabs?.find((x) => x.active) || win.tabs?.[0];
            if (t?.title) titles.push(t.title);
          } catch (_e) {
            // ignore
          }
        }
      }
    } catch (_e) {}
    message = { type: 'split:resetMeta', payload: { titles } };
  }
  try {
    // Use tabs.sendMessage as a reliable channel to split page content
    await chrome.tabs.sendMessage(controllerTabId, message);
  } catch (e) {
    console.error('Failed to send controller meta:', e);
  }
};

/**
 * Check if a controller tab is currently the active tab in its window.
 * @param {number} controllerTabId
 * @returns {Promise<boolean>}
 */
const isControllerTabActive = async (controllerTabId) => {
  try {
    const controller = controllerByTabId.get(controllerTabId);
    if (!controller) return false;

    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId: controller.parentWindowId,
    });

    return activeTab?.id === controllerTabId;
  } catch (_e) {
    return false;
  }
};

/**
 * Check if a window ID is related to any controller (either as parent or popup).
 * @param {number} windowId
 * @returns {boolean}
 */
const isWindowRelatedToController = (windowId) => {
  // Check if it's a popup window
  if (popupWindowIdToControllerTabId.has(windowId)) {
    return true;
  }

  // Check if it's a parent window
  for (const controller of controllerByTabId.values()) {
    if (controller.parentWindowId === windowId) {
      return true;
    }
  }

  return false;
};

/**
 * Refresh stored controller info (index, groupId, window) from the actual tab.
 * @param {number} controllerTabId
 */
const refreshControllerFromTab = async (controllerTabId) => {
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;
  try {
    const tab = await chrome.tabs.get(controllerTabId);
    if (!tab) return;
    if (typeof tab.index === 'number')
      controller.controllerTabIndex = tab.index;
    if (typeof tab.groupId === 'number')
      controller.controllerTabGroupId = tab.groupId;
    if (typeof tab.windowId === 'number')
      controller.parentWindowId = tab.windowId;
    await persistControllers();
  } catch (_e) {
    // ignore
  }
};

// Update action title to indicate what clicking will do in current context
const updateActionTitle = async () => {
  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!activeTab || typeof activeTab.id !== 'number') return;

    let title = 'Sandwich Bear';

    // If current tab is a controller, clicking does nothing
    if (controllerByTabId.has(activeTab.id)) {
      await chrome.action.setTitle({
        title: 'Popup windows linked to this tab; click does nothing',
        tabId: activeTab.id,
      });
      return;
    }

    // Not on split page: show Open {N (2<=N<=4)} tabs in split view
    const windowId = activeTab.windowId;
    const highlightedTabs = await chrome.tabs.query({
      highlighted: true,
      windowId,
    });
    if (highlightedTabs.length <= 1) {
      title = 'Highlight multiple tabs to open in popup windows';
    } else {
      const n = Math.max(2, Math.min(4, highlightedTabs.length));
      title = `Open ${n} tabs in popup windows`;
    }

    await chrome.action.setTitle({ title, tabId: activeTab.id });
  } catch (_e) {
    // no-op
  }
};

// Keep title updated on common events
chrome.tabs.onActivated.addListener(() => {
  updateActionTitle();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, _tab) => {
  if (changeInfo.status === 'complete' || 'url' in changeInfo) {
    updateActionTitle();
  }
});
// Keep controller index/group up to date on tab updated (covers group changes)
chrome.tabs.onUpdated.addListener((tabId, _changeInfo, _tab) => {
  if (controllerByTabId.has(tabId)) {
    refreshControllerFromTab(tabId);
  }
});

// Keep controller index up to date on move/attach
chrome.tabs.onMoved.addListener((tabId, _moveInfo) => {
  if (controllerByTabId.has(tabId)) {
    refreshControllerFromTab(tabId);
  }
});
chrome.tabs.onAttached.addListener((tabId, _attachInfo) => {
  if (controllerByTabId.has(tabId)) {
    refreshControllerFromTab(tabId);
  }
});
chrome.tabs.onDetached.addListener((tabId, _detachInfo) => {
  if (controllerByTabId.has(tabId)) {
    refreshControllerFromTab(tabId);
  }
});
chrome.tabs.onHighlighted.addListener(() => {
  updateActionTitle();
});
chrome.windows.onFocusChanged.addListener(() => {
  updateActionTitle();
});

// Initialize title and focus tracking on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  updateActionTitle();
  await ensureRestoredControllers();
  try {
    const currentWindow = await chrome.windows.getCurrent();
    lastFocusedWindowId = currentWindow?.id || null;
  } catch (_e) {
    lastFocusedWindowId = null;
  }
});
chrome.runtime.onStartup.addListener(async () => {
  updateActionTitle();
  await ensureRestoredControllers();
  try {
    const currentWindow = await chrome.windows.getCurrent();
    lastFocusedWindowId = currentWindow?.id || null;
  } catch (_e) {
    lastFocusedWindowId = null;
  }
});

// Handle action button click: open up to the first 4 highlighted tabs in popup windows
chrome.action.onClicked.addListener(async (currentTab) => {
  try {
    await ensureRestoredControllers();
    // If clicking while on a controller tab, do nothing
    if (
      typeof currentTab.id === 'number' &&
      controllerByTabId.has(currentTab.id)
    ) {
      return;
    }

    // Get highlighted tabs in the current window
    const highlightedTabs = await chrome.tabs.query({
      highlighted: true,
      currentWindow: true,
    });

    // Sort by tab index (left-to-right), take first 4
    const targetTabs = highlightedTabs
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .slice(0, 4);

    if (targetTabs.length < 2) {
      console.log(
        'Highlighted tabs did not include at least two pages; doing nothing.',
      );
      return;
    }

    const firstTab = targetTabs[0];

    // Create a new controller tab (split.html) before the first target tab
    const blankTab = await chrome.tabs.create({
      url: chrome.runtime.getURL('pages/split.html'),
      windowId: currentTab.windowId,
      index: firstTab.index,
    });

    // Get window details for positioning popups
    const window = await chrome.windows.get(currentTab.windowId);
    const windowWidth = window.width || 0;
    const windowHeight = window.height || 0;
    const windowTop = window.top || 0;
    const windowLeft = window.left || 0;

    const availableWidth = Math.max(0, windowWidth - INSET - INSET);
    const totalGaps = Math.max(0, (targetTabs.length - 1) * GAP);
    const availableWidthNoGaps = Math.max(0, availableWidth - totalGaps);
    const availableHeight = Math.max(
      0,
      windowHeight - ADDRESS_BAR_HEIGHT - INSET,
    );
    const baseColumnWidth = Math.floor(
      availableWidthNoGaps / targetTabs.length,
    );

    // Create a popup window for each tab by moving the tab (preserves state)
    /** @type {number[]} */
    const popupWindowIds = [];
    for (let i = 0; i < targetTabs.length; i++) {
      const tab = targetTabs[i];
      if (typeof tab.id !== 'number') continue;
      const isLast = i === targetTabs.length - 1;
      const columnLeft = windowLeft + INSET + i * (baseColumnWidth + GAP);
      const columnWidth = isLast
        ? availableWidthNoGaps - baseColumnWidth * i
        : baseColumnWidth;
      const popup = await chrome.windows.create({
        tabId: tab.id,
        type: 'popup',
        left: columnLeft,
        top: windowTop + ADDRESS_BAR_HEIGHT,
        width: Math.max(50, columnWidth),
        height: Math.max(100, availableHeight),
      });
      if (popup?.id != null) {
        popupWindowIds.push(popup.id);
      }
    }

    // Track association between the blank tab and its popup windows
    if (typeof blankTab.id === 'number') {
      // Initialize equal width ratios for all popups
      /** @type {Record<number, number>} */
      const widthRatios = {};
      const equalRatio =
        popupWindowIds.length > 0 ? 1 / popupWindowIds.length : 1;
      for (const winId of popupWindowIds) {
        widthRatios[winId] = equalRatio;
      }

      controllerByTabId.set(blankTab.id, {
        parentWindowId: currentTab.windowId,
        popupWindowIds,
        controllerTabIndex:
          typeof blankTab.index === 'number' ? blankTab.index : 0,
        controllerTabGroupId:
          typeof blankTab.groupId === 'number' ? blankTab.groupId : -1,
        widthRatios,
      });
      for (const winId of popupWindowIds) {
        popupWindowIdToControllerTabId.set(winId, blankTab.id);
      }
      await persistControllers();
      // Activate the controller tab and ensure its popups are shown/positioned
      try {
        await chrome.tabs.update(blankTab.id, { active: true });
        await showOnlyActiveController(blankTab.id);
      } catch (_e) {
        // ignore
      }
    }

    // Note: original tabs were moved into popups, so no need to close them
  } catch (error) {
    console.error('Failed to open popup windows from highlighted tabs:', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openAnchorLink') {
    // The tabs permission is required for chrome.tabs.create
    chrome.tabs.create({ url: message.url });
  }
});

// Hide/show popups when the active tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    await ensureRestoredControllers();
    const tabId = activeInfo.tabId;
    if (controllerByTabId.has(tabId)) {
      await refreshControllerFromTab(tabId);
      await showOnlyActiveController(tabId);
      await focusFirstPopupWindow(tabId);
      // Active controller tab: use active popup's meta if any; else reset
      try {
        const ctl = controllerByTabId.get(tabId);
        if (ctl) {
          const activePopup = ctl.popupWindowIds[0];
          if (typeof activePopup === 'number') {
            const win = await chrome.windows.get(activePopup, {
              populate: true,
            });
            const activePopupTab =
              win.tabs?.find((t) => t.active) || win.tabs?.[0];
            await postControllerMeta(
              tabId,
              activePopupTab?.title
                ? {
                    title: activePopupTab.title,
                    favicon: activePopupTab.favIconUrl || undefined,
                  }
                : null,
            );
          }
        }
      } catch (_e) {}
    } else {
      // If leaving any controller's tab, hide all controllers in this window
      await Promise.all(
        [...controllerByTabId.entries()].map(async ([controllerTabId, ctl]) => {
          if (ctl.parentWindowId === activeInfo.windowId) {
            await hideControllerPopups(controllerTabId);
          }
        }),
      );
    }
    updateActionTitle();
  } catch (_e) {
    // ignore
  }
});

// When the focused window changes, update visibility accordingly
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  try {
    await ensureRestoredControllers();

    // Check if the previous focus was on a controller-related window
    const wasPreviousFocusOnController =
      lastFocusedWindowId !== null &&
      isWindowRelatedToController(lastFocusedWindowId);

    // On macOS, when Chrome loses focus (user switches to another app),
    // the focused window id becomes WINDOW_ID_NONE. Ensure any popups
    // associated with the previously focused parent window are minimized
    // so they don't remain focused/on-top while Chrome is inactive.
    try {
      const os = await getPlatformOs();
      if (os === 'mac' && windowId === chrome.windows.WINDOW_ID_NONE) {
        await Promise.all(
          [...controllerByTabId.entries()].map(
            async ([controllerTabId, ctl]) => {
              if (ctl.parentWindowId === lastFocusedWindowId) {
                await minimizeControllerPopups(controllerTabId);
              }
            },
          ),
        );
        lastFocusedWindowId = windowId;
        return;
      }
    } catch (_e) {}

    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    // If the focused window is minimized or not valid, avoid restoring popups
    try {
      if (typeof windowId === 'number') {
        const focusedWin = await chrome.windows.get(windowId);
        if (focusedWin?.state === 'minimized') {
          // Minimize any controllers whose parent is this window and bail
          await Promise.all(
            [...controllerByTabId.entries()].map(
              async ([controllerTabId, ctl]) => {
                if (ctl.parentWindowId === windowId) {
                  await minimizeControllerPopups(controllerTabId);
                }
              },
            ),
          );
          lastFocusedWindowId = windowId;
          return;
        }
      }
    } catch (_e) {}
    if (activeTab?.id != null && controllerByTabId.has(activeTab.id)) {
      await refreshControllerFromTab(activeTab.id);
      await showOnlyActiveController(activeTab.id);
      await focusFirstPopupWindow(activeTab.id);
      // Update meta for active controller
      try {
        const ctl = controllerByTabId.get(activeTab.id);
        if (ctl) {
          const activePopup = ctl.popupWindowIds[0];
          if (typeof activePopup === 'number') {
            const win = await chrome.windows.get(activePopup, {
              populate: true,
            });
            const activePopupTab =
              win.tabs?.find((t) => t.active) || win.tabs?.[0];
            await postControllerMeta(
              activeTab.id,
              activePopupTab?.title
                ? {
                    title: activePopupTab.title,
                    favicon: activePopupTab.favIconUrl || undefined,
                  }
                : null,
            );
          }
        }
      } catch (_e) {}
      lastFocusedWindowId = windowId;
      return;
    }

    // If a popup window gained focus, update its controller tab meta directly
    const controllerFromPopup = popupWindowIdToControllerTabId.get(windowId);
    if (typeof controllerFromPopup === 'number') {
      try {
        const win = await chrome.windows.get(windowId, { populate: true });
        const activePopupTab = win.tabs?.find((t) => t.active) || win.tabs?.[0];
        await postControllerMeta(
          controllerFromPopup,
          activePopupTab?.title
            ? {
                title: activePopupTab.title,
                favicon: activePopupTab.favIconUrl || undefined,
              }
            : null,
        );

        // NEW BEHAVIOR: If neither parent nor popup windows had focus before,
        // focus the parent window and activate the split page tab
        if (!wasPreviousFocusOnController) {
          const controller = controllerByTabId.get(controllerFromPopup);
          if (controller) {
            try {
              // If the parent is minimized, keep everything minimized and bail
              try {
                const parentState = await chrome.windows.get(
                  controller.parentWindowId,
                );
                if (parentState?.state === 'minimized') {
                  await minimizeControllerPopups(controllerFromPopup);
                  lastFocusedWindowId = windowId;
                  return;
                }
              } catch (_e) {}
              // Focus the parent window
              await chrome.windows.update(controller.parentWindowId, {
                focused: true,
              });
              // Activate the controller (split page) tab
              await chrome.tabs.update(controllerFromPopup, { active: true });
              // Show the controller's popups
              await showOnlyActiveController(controllerFromPopup);
            } catch (e) {
              console.error(
                'Failed to focus parent window and activate split tab:',
                e,
              );
            }
          }
        }
      } catch (e) {
        console.error('Failed to update controller tab meta:', e);
      }
      lastFocusedWindowId = windowId;
      return;
    }

    // Hide controllers whose parent is this window
    await Promise.all(
      [...controllerByTabId.entries()].map(async ([controllerTabId, ctl]) => {
        if (ctl.parentWindowId === windowId) {
          await hideControllerPopups(controllerTabId);
        }
      }),
    );

    // Non-controller active tab: reset any controller tabs in this window
    await Promise.all(
      [...controllerByTabId.entries()].map(async ([controllerTabId, ctl]) => {
        if (ctl.parentWindowId === windowId) {
          await postControllerMeta(controllerTabId, null);
        }
      }),
    );

    lastFocusedWindowId = windowId;
  } catch (_e) {
    // ignore
  }
});

// When the parent window moves or resizes, retile its popups
chrome.windows.onBoundsChanged.addListener(async (win) => {
  try {
    await ensureRestoredControllers();
    const windowId = win.id;
    if (!windowId) return;

    // Ignore bounds events caused by our own updates
    if (programmaticUpdateWindowIds.has(windowId)) {
      return;
    }
    const affectedControllers = [...controllerByTabId.entries()].filter(
      ([, ctl]) => ctl.parentWindowId === windowId,
    );

    // If the parent window is minimized, minimize all associated popups
    if (win.state === 'minimized' && affectedControllers.length > 0) {
      await Promise.all(
        affectedControllers.map(async ([tabId]) =>
          minimizeControllerPopups(tabId),
        ),
      );
      return;
    }
    // Only bring popups to front if the controller tab is currently active
    await Promise.all(
      affectedControllers.map(async ([tabId]) => {
        const isActive = await isControllerTabActive(tabId);
        if (isActive) {
          await applyProportionalLayout(tabId);
        }
      }),
    );

    // If a popup window was maximized, maximize the parent window and re-tile
    const controllerFromPopup = popupWindowIdToControllerTabId.get(windowId);
    if (typeof controllerFromPopup === 'number') {
      try {
        const changedWin = await chrome.windows.get(windowId);
        if (changedWin?.state === 'maximized') {
          const ctl = controllerByTabId.get(controllerFromPopup);
          if (ctl && typeof ctl.parentWindowId === 'number') {
            programmaticUpdateWindowIds.add(ctl.parentWindowId);
            try {
              await chrome.windows.update(ctl.parentWindowId, {
                state: 'maximized',
              });
            } finally {
              // allow a short delay to swallow immediate bounce events
              setTimeout(
                () => programmaticUpdateWindowIds.delete(ctl.parentWindowId),
                100,
              );
            }
            await applyProportionalLayout(controllerFromPopup);
          }
        }
      } catch (_e) {
        // ignore
      }
    }

    // If a popup window is moved manually (state normal), re-tile to restore layout
    if (typeof controllerFromPopup === 'number') {
      try {
        const win = await chrome.windows.get(windowId);
        if (win?.state === 'normal') {
          const existing = retileTimeoutByController.get(controllerFromPopup);
          if (existing) {
            clearTimeout(existing);
          }
          const timeoutId = setTimeout(() => {
            retileTimeoutByController.delete(controllerFromPopup);
            reflowAfterPopupResize(controllerFromPopup, windowId);
          }, 120);
          // @ts-ignore - timeout id type differs across runtimes
          retileTimeoutByController.set(controllerFromPopup, timeoutId);
        }
      } catch (_e) {
        // ignore
      }
    }
  } catch (_e) {
    // ignore
  }
});

// When the controller (blank) tab is closed, restore popups to tabs and cleanup
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureRestoredControllers();
  if (!controllerByTabId.has(tabId)) return;
  const controller = controllerByTabId.get(tabId);
  if (!controller) return;
  try {
    // Sync latest position/group before restoring
    await refreshControllerFromTab(tabId);

    // Collect active tab ids from each popup window (preserve order)
    /** @type {number[]} */
    const popupActiveTabIds = [];
    for (const winId of controller.popupWindowIds) {
      try {
        const popupWin = await chrome.windows.get(winId, { populate: true });
        const activeTab =
          popupWin.tabs?.find((t) => t.active) || popupWin.tabs?.[0];
        if (typeof activeTab?.id === 'number')
          popupActiveTabIds.push(activeTab.id);
      } catch (_e) {
        // window may be gone; skip
      }
    }

    // Check if parent window still exists, create new window if not
    let targetWindowId = controller.parentWindowId;
    let targetTabGroupId = controller.controllerTabGroupId;
    let idx = controller.controllerTabIndex || 0;

    try {
      await chrome.windows.get(controller.parentWindowId);
    } catch (_e) {
      // Parent window is gone, create a new window for the first tab
      if (popupActiveTabIds.length > 0) {
        try {
          const newWindow = await chrome.windows.create({
            tabId: popupActiveTabIds[0],
            state: 'maximized',
          });
          if (newWindow?.id) {
            targetWindowId = newWindow.id;
            targetTabGroupId = -1; // Use -1 to indicate no group (instead of null)
            idx = 1; // First tab is already in the new window
          }
        } catch (_e) {
          // Failed to create new window, fallback to default behavior
        }
      }
    }

    // If the controller was in a tab group, handle group placement directly
    if (typeof targetTabGroupId === 'number' && targetTabGroupId >= 0) {
      // Move tabs to the target window first (to the end to avoid index issues)
      for (let i = idx === 1 ? 1 : 0; i < popupActiveTabIds.length; i++) {
        const tabIdToMove = popupActiveTabIds[i];
        try {
          await chrome.tabs.move(tabIdToMove, {
            windowId: targetWindowId,
            index: -1, // Move to end first
          });
        } catch (_e) {
          // ignore failures per tab
        }
      }

      // Then group all tabs and position them correctly within the group
      const baseIndex = controller.controllerTabIndex || 0;
      for (let i = 0; i < popupActiveTabIds.length; i++) {
        const movedTabId = popupActiveTabIds[i];
        try {
          await chrome.tabs.group({
            tabIds: movedTabId,
            groupId: targetTabGroupId,
          });
          await chrome.tabs.move(movedTabId, {
            windowId: targetWindowId,
            index: baseIndex + i,
          });
        } catch (_e) {
          // ignore
        }
      }
    } else {
      // Original logic for tabs not in a group
      for (let i = idx === 1 ? 1 : 0; i < popupActiveTabIds.length; i++) {
        const tabIdToMove = popupActiveTabIds[i];
        try {
          await chrome.tabs.move(tabIdToMove, {
            windowId: targetWindowId,
            index: idx,
          });
          idx += 1;
        } catch (_e) {
          // ignore failures per tab
        }
      }
    }

    // Close popup windows
    await Promise.all(
      controller.popupWindowIds.map(async (winId) => {
        try {
          await chrome.windows.remove(winId);
        } catch (_e) {
          // ignore
        }
      }),
    );
  } catch (_e) {
    // ignore
  } finally {
    cleanupController(tabId);
    await persistControllers();
  }
});

// Cleanup reverse mapping if a popup window is closed manually
chrome.windows.onRemoved.addListener((windowId) => {
  // Best-effort restore before cleanup
  ensureRestoredControllers()
    .then(() => {})
    .catch(() => {});
  const controllerTabId = popupWindowIdToControllerTabId.get(windowId);
  if (controllerTabId == null) return;
  popupWindowIdToControllerTabId.delete(windowId);
  const controller = controllerByTabId.get(controllerTabId);
  if (!controller) return;
  controller.popupWindowIds = controller.popupWindowIds.filter(
    (id) => id !== windowId,
  );

  // Remove and normalize width ratios
  if (controller.widthRatios) {
    delete controller.widthRatios[windowId];

    // Renormalize remaining ratios
    const remainingIds = controller.popupWindowIds;
    if (remainingIds.length > 0) {
      const remainingRatios = remainingIds.map(
        (id) => controller.widthRatios[id] || 0,
      );
      const ratioSum =
        remainingRatios.reduce((sum, ratio) => sum + ratio, 0) || 1;

      for (let i = 0; i < remainingIds.length; i++) {
        controller.widthRatios[remainingIds[i]] = remainingRatios[i] / ratioSum;
      }
    }
  }

  // If all popups are gone, we can optionally close the controller tab to avoid orphaning
  if (controller.popupWindowIds.length === 0) {
    chrome.tabs.remove(controllerTabId).catch(() => {});
    cleanupController(controllerTabId);
    persistControllers().catch(() => {});
  } else if (controller.popupWindowIds.length === 1) {
    // Restore the last remaining popup to a normal tab and clean up
    (async () => {
      try {
        const lastWinId = controller.popupWindowIds[0];
        let activeTabId = undefined;
        try {
          const lastWin = await chrome.windows.get(lastWinId, {
            populate: true,
          });
          const activeTab =
            lastWin.tabs?.find((t) => t.active) || lastWin.tabs?.[0];
          if (typeof activeTab?.id === 'number') activeTabId = activeTab.id;
        } catch (_e) {}

        if (typeof activeTabId === 'number') {
          // Check if controller had a group
          if (
            typeof controller.controllerTabGroupId === 'number' &&
            controller.controllerTabGroupId >= 0
          ) {
            // For grouped tabs, move to end first, then group and position
            try {
              await chrome.tabs.move(activeTabId, {
                windowId: controller.parentWindowId,
                index: -1, // Move to end first
              });
              await chrome.tabs.group({
                tabIds: activeTabId,
                groupId: controller.controllerTabGroupId,
              });
              await chrome.tabs.move(activeTabId, {
                windowId: controller.parentWindowId,
                index: controller.controllerTabIndex || 0,
              });
            } catch (_e) {}
          } else {
            // For non-grouped tabs, use original logic
            try {
              await chrome.tabs.move(activeTabId, {
                windowId: controller.parentWindowId,
                index: controller.controllerTabIndex || 0,
              });
            } catch (_e) {}
          }
        }

        // Remove mapping for the last popup and close it
        popupWindowIdToControllerTabId.delete(lastWinId);
        controller.popupWindowIds = [];
        try {
          await chrome.windows.remove(lastWinId);
        } catch (_e) {}

        // Finally, close the controller tab and cleanup
        try {
          await chrome.tabs.remove(controllerTabId);
        } catch (_e) {}
        cleanupController(controllerTabId);
        await persistControllers();
      } catch (_e) {
        // ignore
      }
    })();
  } else {
    // Re-tile remaining popups to fill gaps using proportional layout
    applyProportionalLayout(controllerTabId).catch(() => {});
    persistControllers().catch(() => {});
  }
});
