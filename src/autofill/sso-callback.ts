// Registered only while an SSO login is in progress, and only for <server>/sso-connector.html.
// The service worker reads the code from sender.url, so nothing from the page is sent along.
void chrome.runtime.sendMessage({ type: "ssoCallback" });
