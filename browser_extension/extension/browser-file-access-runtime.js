const FILE_ACCESS_INSTRUCTION =
  "Chrome must grant AG access to local files. Open chrome://extensions, find AG, choose Details, turn on “Allow access to file URLs”, then retry. AG cannot enable this permission for you.";

function isFileUrl(value) {
  try {
    return new URL(String(value || "")).protocol === "file:";
  } catch {
    return false;
  }
}

function allowedFileSchemeAccess(chromeApi) {
  return new Promise((resolve) => {
    const check = chromeApi?.extension?.isAllowedFileSchemeAccess;
    if (typeof check !== "function") {
      resolve({ allowed: false, supported: false, instruction: FILE_ACCESS_INSTRUCTION });
      return;
    }
    let settled = false;
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      resolve({
        allowed: allowed === true,
        supported: true,
        ...(allowed === true ? {} : { instruction: FILE_ACCESS_INSTRUCTION }),
      });
    };
    try {
      const pending = check.call(chromeApi.extension, finish);
      if (pending && typeof pending.then === "function") pending.then(finish, () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function authorizeBrowserUrl(chromeApi, value, allowedProtocols = new Set(["http:", "https:", "file:"])) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (!allowedProtocols.has(url.protocol)) return { ok: false, error: "blocked_url_scheme" };
  if (url.protocol !== "file:") return { ok: true, url: url.href };
  const access = await allowedFileSchemeAccess(chromeApi);
  return access.allowed
    ? { ok: true, url: url.href, file_access: access }
    : { ok: false, error: "file_scheme_access_disabled", file_access: access, instruction: access.instruction };
}

export { FILE_ACCESS_INSTRUCTION, allowedFileSchemeAccess, authorizeBrowserUrl, isFileUrl };
