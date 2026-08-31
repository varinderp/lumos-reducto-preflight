export function normalizeAppBasePath(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "/") return "";
  if (!trimmed.startsWith("/")) {
    throw new Error("NEXT_PUBLIC_LUMOS_BASE_PATH must start with '/'.");
  }
  return trimmed.replace(/\/+$/, "");
}

export const APP_BASE_PATH = normalizeAppBasePath(
  process.env.NEXT_PUBLIC_LUMOS_BASE_PATH,
);

export function appPath(pathname: string) {
  if (!pathname.startsWith("/")) {
    throw new Error("Application paths must start with '/'.");
  }
  return `${APP_BASE_PATH}${pathname}`;
}
