(() => {
  try {
    const key = 'myagents:theme-bootstrap';
    const runKey = 'myagents:theme-native-bootstrap-run';
    const runId = __MYAGENTS_BOOTSTRAP_RUN_ID__;
    if (localStorage.getItem(runKey) === runId) return;

    let themeId = 'default-black';
    let themeSelectionExplicit = false;
    const raw = localStorage.getItem(key);

    if (raw) {
      try {
        const snapshot = JSON.parse(raw);
        if (
          snapshot
          && (snapshot.version === 1 || snapshot.version === 2)
        ) {
          const storedThemeId = typeof snapshot.themeId === 'string'
            ? snapshot.themeId.trim()
            : '';
          themeSelectionExplicit = snapshot.version === 2
            ? snapshot.themeSelectionExplicit === true && storedThemeId !== ''
            : storedThemeId !== '' && storedThemeId !== 'myagents-default';
          if (themeSelectionExplicit) themeId = storedThemeId;
        }
      } catch {
        // A damaged snapshot must not prevent durable appearance alignment.
      }
    }

    localStorage.setItem(key, JSON.stringify({
      version: 2,
      themeId,
      appearanceMode: __MYAGENTS_APPEARANCE_MODE__,
      themeSelectionExplicit,
    }));
    // initialization_script runs again on reload. Mark this native process
    // only after the snapshot write succeeds, so a reload cannot overwrite a
    // newer appearance already published by ThemeRuntime.
    localStorage.setItem(runKey, runId);
    localStorage.removeItem('theme');
  } catch {
    // Private-mode or disabled storage must never block native startup.
  }
})();
