const HOME_ICON_NAME = "home";
const HOME_ICON_CODE = 57377;

function isHomeIconName(name) {
  return String(name || "").trim() === HOME_ICON_NAME;
}

function homeIconCode() {
  return HOME_ICON_CODE;
}

function navigationIconPolicyForPrompt() {
  return 'Navigation icons are optional. If an icon is provided, use only { "name": "home" }. Do not use numeric icon codes or other icon names.';
}

module.exports = {
  HOME_ICON_NAME,
  HOME_ICON_CODE,
  isHomeIconName,
  homeIconCode,
  navigationIconPolicyForPrompt
};
