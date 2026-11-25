// This is a lexical check for display and risk classification. The host may
// resolve a symlink, mount or alias differently. No filesystem access is used.
const sensitiveFolders = new Set([".ssh", ".aws", ".gnupg", ".kube", ".azure", ".credentials", ".secrets"]);
const sensitiveFiles = new Set([
  ".netrc", "_netrc", ".git-credentials", ".npmrc", ".pypirc", ".envrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "credentials.json", "secrets.json", "secrets.yaml", "secrets.yml",
]);

const windowsPath = /^[a-z]:[\\/]|^\\\\/i;

function pathText(value: string, cwd?: string) {
  return windowsPath.test(value) || cwd && windowsPath.test(cwd) ? value.replace(/\\/g, "/") : value;
}

const isAbsolute = (path: string) => /^(?:\/|[a-z]:\/|~(?:[^/]*\/|$))/i.test(path);

export function resolveReadPath(value: string, cwd?: string) {
  const path = pathText(value, cwd);
  const text = !isAbsolute(path) && cwd ? pathText(cwd) + "/" + path : path;
  const root = text.match(/^(?:\/\/[^/]+\/[^/]+\/|\/+|[a-z]:\/|~[^/]*\/)/i)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of text.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.at(-1) && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + parts.join("/");
}

export function readPathRisks(value: string, cwd?: string, workspace?: string): ("sensitive-read" | "outside-read")[] {
  if (!value || value === "-") return [];
  const raw = pathText(value, cwd);
  const path = resolveReadPath(value, cwd);
  const parts = path.toLowerCase().split("/");
  const file = parts.at(-1) ?? "";
  const sensitive = [...parts, ...raw.toLowerCase().split("/")].some(part => sensitiveFolders.has(part) || /^\.env(?:\.|$)/.test(part)) ||
    sensitiveFiles.has(file) || /\.(?:pem|key|p12|pfx|tfvars(?:\.json)?)$/.test(file) ||
    /\/(?:etc\/(?:shadow|gshadow|passwd)|\.docker\/config\.json)$/.test(path.toLowerCase());
  const base = workspace ? resolveReadPath(workspace).replace(/\/$/, "") : undefined;
  const driveRelative = /^[a-z]:[^/]/i.test(raw);
  const outside = driveRelative || (base !== undefined && isAbsolute(path) ? path !== base && !path.startsWith(base + "/")
    : isAbsolute(raw) || /^\.\.(?:\/|$)/.test(resolveReadPath(path)));
  return [...(sensitive ? ["sensitive-read" as const] : []), ...(outside ? ["outside-read" as const] : [])];
}

// Names the read-only rule never approves on its own. This list is wider than the card's
// "sensitive" label on purpose: a harmless file sent to a person costs one press, and a
// secret read without one cannot be taken back. It is matched against every word of a request,
// whether or not that word is a path, and again against each resolved path on the host.
const guardedName = /^(?:id_|\.?credentials?|\.?secrets?|\.?passw(?:or)?ds?|\.?tokens?(?:[._-]|$)|\.(?:pgpass|my\.cnf|htpasswd)$)|\.env|keychain|_history$|\.(?:kdbx|jks|keystore|p8|ppk|gpg|asc)$/;
const guardedFolder = /(?:^|\/)\.config\/(?:gh|gcloud|op)(?:\/|$)|(?:^|\/)\.docker(?:\/|$)|(?:^|\/)library\/(?:keychains|cookies)(?:\/|$)/;

export function guardedWord(word: string) {
  const text = word.replace(/\\/g, "/").toLowerCase();
  if (readPathRisks(word).includes("sensitive-read") || guardedFolder.test(text)) return true;
  return text.split(/[/=:,]/).some(part => guardedName.test(part) || readPathRisks(part).includes("sensitive-read"));
}
