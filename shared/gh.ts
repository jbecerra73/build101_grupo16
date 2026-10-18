// The GitHub CLI for tenki sandboxes. The base image's gh is too old: GitHub removed Projects
// (classic) from the API, and gh before ~2.80 still asks for `projectCards`, so `gh pr edit`
// fails with "Projects (classic) is being deprecated" (cli/cli#12320). The orchestrator's
// sandbox and the coding agent's install this pinned release under their home instead.

export const GH_CLI_VERSION = "2.102.0";

/** Bash that installs gh GH_CLI_VERSION into `<dir>/bin/gh` (linux, amd64 or arm64), unless it is already there. */
export function ghInstallScript(dir: string): string {
  const url = `https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_$ARCH.tar.gz`;
  return (
    `if ! "${dir}/bin/gh" --version 2>/dev/null | grep -q "gh version ${GH_CLI_VERSION} "; then ` +
    `case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac && ` +
    `rm -rf "${dir}" && mkdir -p "${dir}" && curl -fsSL "${url}" | tar -xz -C "${dir}" --strip-components=1; fi && ` +
    `"${dir}/bin/gh" --version | head -1`
  );
}
