// Annotate Playwright actions without listening to the user's real mouse.
// This is the fixed action-only display pattern from the existing Zed setup:
// no DOM pointermove handler, no duplicate cursor marker following the owner.
exports.default = async ({ page }) => {
  await page.screencast.showActions({
    cursor: 'pointer',
    duration: 1500,
    position: 'top-right',
  });
};
