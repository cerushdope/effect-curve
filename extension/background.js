// background.js — the only thing this extension needs a service worker for.
//
// Without this, clicking the toolbar icon does nothing: an action with no popup
// and no listener is inert. `setPanelBehavior` makes the click open the side
// panel directly, which is one call and then the worker can go back to sleep.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("Could not set side panel behavior:", e));
});
