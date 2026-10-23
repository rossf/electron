#!/usr/bin/env python3
"""Bounded source checks for the public fork; no native build or credentials."""

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import urllib.request

REPOSITORY = "rossf/electron"
NODE_VERSION = "22.23.3"
NODE_SHA256 = "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
DEPOT_REVISION = "8a5434051036b32412a2ecb10c213a72e3f3ccb9"
STORAGE_PATCH = "fix_allow_blocking_in-memory_dom_storage_shutdown.patch"
STORAGE_FILE = "components/services/storage/dom_storage/dom_storage_database.cc"
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
BRANCH_KINDS = {
    "experimental/linux-phone-passkey-preservation": "authentication",
    "experimental/linux-phone-passkey-main": "authentication",
    "fix/in-memory-storage-shutdown": "storage",
    "docs/fork-ci-active-status": "ci",
    "experimental/linux-phone-passkey-create-main": "simplification",
    "experimental/linux-phone-passkey-api-main": "simplification",
}


def run(arguments, root, **kwargs):
    """Run a command without interpolating source data into a shell."""
    return subprocess.run(arguments, cwd=root, check=True, text=True, **kwargs)


def output(arguments, root):
    """Capture a small command result."""
    return run(arguments, root, stdout=subprocess.PIPE).stdout.strip()


def fetch(url):
    """Fetch a public, bounded input with a deadline."""
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise ValueError("Download exceeds the source-check limit")
    return data


def github(endpoint):
    """Read public fork metadata with the workflow's read-only token."""
    request = urllib.request.Request("https://api.github.com/" + endpoint)
    request.add_header("Accept", "application/vnd.github+json")
    token = os.environ.get("GH_TOKEN")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def checked_sha(value):
    """Accept only a complete immutable Git object name."""
    if not SHA_PATTERN.fullmatch(value):
        raise ValueError("Expected a complete Git SHA")
    return value


def matrix():
    """Resolve immutable candidate/source heads before any parallel checks."""
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    pull = event["pull_request"]
    if (event["repository"]["full_name"] != REPOSITORY
            or pull["head"]["repo"]["full_name"] != REPOSITORY):
        raise ValueError("Only this fork's own PR heads are permitted")
    kind = BRANCH_KINDS[pull["head"]["ref"]]
    targets = [("this-pr", pull["head"]["sha"], pull["base"]["sha"], kind)]
    if pull["head"]["ref"] == "docs/fork-ci-active-status":
        for number, name in ((1, "authentication-43"), (2, "storage")):
            source = github(f"repos/{REPOSITORY}/pulls/{number}")
            if source["head"]["repo"]["full_name"] != REPOSITORY:
                raise ValueError("Unexpected source repository")
            targets.append((name, source["head"]["sha"], source["base"]["sha"],
                            BRANCH_KINDS[source["head"]["ref"]]))
        head = github(f"repos/{REPOSITORY}/git/ref/heads/experimental/linux-phone-passkey-main")
        base = github(f"repos/{REPOSITORY}/git/ref/heads/main")
        targets.append(("authentication-main", head["object"]["sha"], base["object"]["sha"],
                        "authentication"))
    include = []
    for name, head, base, kind in targets:
        checked_sha(head)
        checked_sha(base)
        comparison = github(f"repos/{REPOSITORY}/compare/{base}...{head}")
        merge_base = checked_sha(comparison["merge_base_commit"]["sha"])
        include.append({"name": name, "head": head, "base": base,
                        "merge_base": merge_base, "kind": kind})
    value = json.dumps({"include": include}, separators=(",", ":"))
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as stream:
        stream.write("targets=" + value + "\n")
    print(json.dumps(include, indent=2))


def chromium_inputs(root, tools_root):
    """Resolve the DEPS version to a commit, without executing DEPS."""
    deps = (root / "DEPS").read_text()
    match = re.search(r"['\"]chromium_version['\"]\s*:\s*['\"]([0-9.]+)['\"]", deps)
    if not match or not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", match[1]):
        raise ValueError("No literal pinned Chromium version in DEPS")
    version = match[1]
    lines = output(["git", "ls-remote", "--refs",
                    "https://chromium.googlesource.com/chromium/src.git",
                    "refs/tags/" + version], root).splitlines()
    if len(lines) != 1:
        raise ValueError("Chromium tag did not resolve uniquely")
    commit = checked_sha(lines[0].split()[0])
    prefix = f"https://raw.githubusercontent.com/chromium/chromium/{commit}/"
    chromium_deps = fetch(prefix + "DEPS").decode()
    buildtools_deps = fetch(prefix + "buildtools/DEPS").decode()
    metadata = {"chromium_version": version, "chromium_commit": commit,
                "source_head": output(["git", "rev-parse", "HEAD"], root),
                "yarn_lock_sha256": hashlib.sha256((root / "yarn.lock").read_bytes()).hexdigest(),
                "node_version": NODE_VERSION, "depot_tools_commit": DEPOT_REVISION}
    (tools_root / "source-inputs.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))
    return chromium_deps, buildtools_deps


def install_node(tools_root):
    """Use an official checksummed Node archive; no additional action needed."""
    archive = tools_root / "node.tar.xz"
    archive.write_bytes(fetch(f"https://nodejs.org/dist/v{NODE_VERSION}/"
                             f"node-v{NODE_VERSION}-linux-x64.tar.xz"))
    if hashlib.sha256(archive.read_bytes()).hexdigest() != NODE_SHA256:
        raise ValueError("Node checksum mismatch")
    with tarfile.open(archive) as package:
        package.extractall(tools_root, filter="data")
    return tools_root / f"node-v{NODE_VERSION}-linux-x64/bin"


def install_format_tools(root, tools_root, chromium_deps, buildtools_deps):
    """Install only pinned depot tools, GN and the small clang-format binary."""
    depot = tools_root / "depot_tools"
    run(["git", "init", "--quiet", str(depot)], root)
    run(["git", "fetch", "--quiet", "--depth=1",
         "https://chromium.googlesource.com/chromium/tools/depot_tools.git",
         DEPOT_REVISION], depot)
    run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], depot)
    assignments = ast.parse(buildtools_deps).body
    deps = next(ast.literal_eval(item.value) for item in assignments
                if isinstance(item, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "deps"
                        for target in item.targets))
    formatter = deps["linux64-format"]
    item, = formatter["objects"]
    if formatter["bucket"] != "chromium-clang-format" or item["output_file"] != "clang-format":
        raise ValueError("Unexpected clang-format dependency layout")
    binary = fetch("https://storage.googleapis.com/chromium-clang-format/"
                   + item["object_name"] + "?generation=" + str(item["generation"]))
    if len(binary) != item["size_bytes"] or hashlib.sha256(binary).hexdigest() != item["sha256sum"]:
        raise ValueError("clang-format checksum or size mismatch")
    buildtools = root.parent / "buildtools"
    target = buildtools / "linux64-format/clang-format"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(binary)
    target.chmod(0o755)
    gn_version = re.search(r"'gn_version'\s*:\s*'(git_revision:[0-9a-f]{40})'", chromium_deps)
    if not gn_version:
        raise ValueError("Missing pinned GN version")
    run([str(depot / "cipd"), "ensure", "-root", str(buildtools / "linux64"),
         "-ensure-file", "-"], root,
        input="gn/gn/linux-amd64 " + gn_version[1] + "\n")
    (root.parent / "DEPS").write_text(chromium_deps)
    (root.parent.parent / ".gclient").touch()
    return depot, buildtools


def setup(root, tools_root):
    """Prepare ephemeral, bounded CI tools and the target's locked JS packages."""
    tools_root.mkdir(parents=True, exist_ok=True)
    node_bin = install_node(tools_root)
    os.environ["DEPOT_TOOLS_UPDATE"] = "0"
    os.environ["DEPOT_TOOLS_METRICS"] = "0"
    os.environ["CIPD_CACHE_DIR"] = str(tools_root / "cipd-cache")
    os.environ["VPYTHON_VIRTUALENV_ROOT"] = str(tools_root / "vpython")
    os.environ["PATH"] = str(node_bin) + os.pathsep + os.environ["PATH"]
    chromium_deps, buildtools_deps = chromium_inputs(root, tools_root)
    depot, buildtools = install_format_tools(root, tools_root, chromium_deps, buildtools_deps)
    run(["bash", "-e", "-c", 'source "$1/bootstrap_python3"; bootstrap_python3',
         "bootstrap-python", str(depot)], root)
    venv = tools_root / "python"
    run([str(depot / "python-bin/python3"), "-m", "venv", "--clear", str(venv)], root)
    run([str(venv / "bin/python"), "-m", "pip", "install",
         "pylint==2.17.7", "pylint-quotes==0.2.1"], root)
    (venv / "bin/pylint-2.17").symlink_to("pylint")
    wrappers = tools_root / "bin"
    wrappers.mkdir()
    cpplint = wrappers / "cpplint.py"
    cpplint.write_text('#!/bin/sh\nexec python3 "' + str(depot / "cpplint.py") + '" "$@"\n')
    cpplint.chmod(0o755)
    paths = [wrappers, venv / "bin", node_bin, buildtools / "linux64", depot,
             root / "node_modules/.bin"]
    environment = {key: os.environ[key] for key in
                   ("DEPOT_TOOLS_UPDATE", "DEPOT_TOOLS_METRICS", "CIPD_CACHE_DIR",
                    "VPYTHON_VIRTUALENV_ROOT")}
    environment["CHROMIUM_BUILDTOOLS_PATH"] = str(buildtools)
    environment["PYLINTRC"] = str(depot / "pylintrc-2.17")
    os.environ.update(environment)
    os.environ["PATH"] = os.pathsep.join(map(str, paths)) + os.pathsep + os.environ["PATH"]
    with Path(os.environ["GITHUB_PATH"]).open("a", encoding="utf-8") as stream:
        # Actions prepends entries in reverse file order in the next step.
        stream.write("\n".join(map(str, reversed(paths))) + "\n")
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as stream:
        stream.write("".join(f"{key}={value}\n" for key, value in environment.items()))
    run(["node", "script/yarn.js", "install", "--immutable"], root)


def changed_files(root, base):
    """Read the actual PR comparison, including safe NUL-separated filenames."""
    checked_sha(base)
    data = run(["git", "diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"],
               root, stdout=subprocess.PIPE).stdout
    files = [name for name in data.split("\0") if name]
    for name in files:
        if (not re.fullmatch(r"[A-Za-z0-9_./-]+", name) or name.startswith(("/", "-"))
                or ".." in Path(name).parts):
            raise ValueError("Filename is unsafe for the inherited shell-based linters")
    return files


def patch_registry(root):
    """Check the entire Chromium patch registry even for .patches-only edits."""
    directory = root / "patches/chromium"
    names = (directory / ".patches").read_text().splitlines()
    if len(names) != len(set(names)) or any(Path(name).name != name for name in names):
        raise ValueError("Duplicate or invalid patch registry entry")
    if set(names) != {path.name for path in directory.glob("*.patch")}:
        raise ValueError("Patch registry and files differ")
    return names


def lint(root, base):
    """Run inherited changed-file checks and explicit CommonJS/format checks."""
    files = changed_files(root, base)
    run(["git", "diff", "--check", base, "HEAD"], root)
    patch_registry(root)
    print("Changed files:\n" + "\n".join(files), flush=True)
    commands = []
    if files:
        commands.append(["node", "script/yarn.js", "exec", "node", "script/lint.js",
                         "--only", "--", *files])
    commonjs = [name for name in files if name.endswith(".cjs")]
    if commonjs:
        commands.append(["node", "script/yarn.js", "oxlint", "--", *commonjs])
    formatted = [name for name in files if Path(name).suffix in (".js", ".ts", ".mjs", ".mts", ".cjs")]
    if formatted:
        commands.append(["node", "script/yarn.js", "oxfmt", "--check", "--", *formatted])
    failures = []
    for command in commands:
        try:
            run(command, root)
        except subprocess.CalledProcessError as error:
            failures.append(str(error))
    if failures:
        raise RuntimeError("\n".join(failures))


def types(root):
    """Generate real declarations and run Electron's actual compiler checks."""
    smoke = root / "spec/ts-smoke/fork-hybrid-api.ts"
    config = root / "spec/ts-smoke/fork-hybrid-tsconfig.json"
    api_docs = (root / "docs/api/session.md").read_text()
    has_hybrid = "ses.setWebAuthnHybridHandler(handler)" in api_docs
    simplified = "The handler returns no value." in api_docs
    if smoke.exists() or config.exists():
        raise ValueError("Refusing to overwrite a source file")
    try:
        if has_hybrid:
            smoke.write_text('import { session } from "electron";\n'
                             'session.defaultSession.setWebAuthnHybridHandler((details, cancel) => {\n'
                             '  const requestId: string = details.requestId;\n'
                             '  const state: string = details.state;\n'
                             '  if (cancel) cancel();\n'
                             '  void requestId; void state; return true;\n'
                             '});\n'
                             'session.defaultSession.setWebAuthnHybridHandler(null);\n'
                             '// @ts-expect-error a number is not an ownership callback\n'
                             'session.defaultSession.setWebAuthnHybridHandler(123);\n')
        if has_hybrid and "* `requestType` string" in api_docs:
            with smoke.open("a", encoding="utf-8") as stream:
                stream.write('session.defaultSession.setWebAuthnHybridHandler(details => {\n'
                             '  const kind: string = details.requestType;\n'
                             '  // @ts-expect-error requestType must not be an untyped number\n'
                             '  const invalid: number = details.requestType;\n'
                             '  void kind; void invalid; return true;\n'
                             '});\n')
        if simplified:
            with smoke.open("a", encoding="utf-8") as stream:
                stream.write('session.defaultSession.setWebAuthnHybridHandler((details, cancel) => {\n'
                             '  if (details.state === "ready") details.qrCode?.startsWith("FIDO:/");\n'
                             '  void cancel;\n'
                             '});\n'
                             'type Handler = NonNullable<Parameters<typeof session.defaultSession.setWebAuthnHybridHandler>[0]>;\n'
                             'type Assert<T extends true> = T;\n'
                             'type ReturnsVoid = Assert<ReturnType<Handler> extends void ? true : false>;\n'
                             'type AcceptsVoid = Assert<void extends ReturnType<Handler> ? true : false>;\n'
                             '// @ts-expect-error handler is void, not a synchronous boolean decision\n'
                             'const oldAcknowledgement: ReturnType<Handler> = true;\n'
                             'const contract: ReturnsVoid & AcceptsVoid = true;\n'
                             'void contract; void oldAcknowledgement;\n')
        run(["node", "script/yarn.js", "create-typescript-definitions"], root)
        if has_hybrid and "setWebAuthnHybridHandler" not in (root / "electron.d.ts").read_text():
            raise ValueError("Generated declarations omitted the hybrid API")
        if has_hybrid:
            # Upstream uses an explicit files list, so a new file alone is not compiled.
            config.write_text(json.dumps({"extends": "./tsconfig.json",
                                          "files": ["fork-hybrid-api.ts", "../../electron.d.ts"]}))
            run(["node", "script/yarn.js", "exec", "tsc", "--project", str(config)], root)
        run(["node", "script/yarn.js", "lint:ts-check-js-in-markdown"], root)
    finally:
        if has_hybrid:
            smoke.unlink(missing_ok=True)
            config.unlink(missing_ok=True)


def patch_paths(text):
    """Identify every complete file delta rather than silently dropping hunks."""
    headers = [line for line in text.splitlines() if line.startswith("diff ")]
    pairs = [re.fullmatch(r"diff --git a/(\S+) b/(\S+)", line) for line in headers]
    if not pairs or any(not pair or pair[1] != pair[2] for pair in pairs):
        raise ValueError("Unsupported missing or renamed patch target")
    stats = subprocess.run(["git", "apply", "--numstat", "-z"], input=text,
                           check=True, text=True, stdout=subprocess.PIPE).stdout
    deltas = [record.split("\t", 2) for record in stats.split("\0") if record]
    if (len(deltas) != len(pairs) or any(len(delta) != 3 for delta in deltas)
            or [delta[2] for delta in deltas] != [pair[1] for pair in pairs]):
        raise ValueError("Unsupported or unaccounted patch delta")
    return {pair[1] for pair in pairs}


def apply_storage_patch(root, tree):
    """Apply ordered predecessor hunks, then the complete storage-only patch."""
    names = patch_registry(root)
    if STORAGE_PATCH not in names:
        raise ValueError("Storage patch is not registered")
    directory = root / "patches/chromium"
    text = (directory / STORAGE_PATCH).read_text()
    if patch_paths(text) != {STORAGE_FILE}:
        raise ValueError("Targeted check cannot validate a multi-file storage patch")
    if (not re.search(r"^Subject: .+", text, re.MULTILINE)
            or "Remove it when" not in text
            or any(line.startswith("+") and line.rstrip() != line for line in text.splitlines())):
        raise ValueError("Storage patch lacks metadata/removal condition or has whitespace errors")
    predecessors = []
    for name in names[:names.index(STORAGE_PATCH)]:
        path = directory / name
        content = path.read_text()
        # Inspect both paths to catch renames into or away from the target.
        if re.search(r"^(?:diff --git |--- |\+\+\+ ).*" + re.escape(STORAGE_FILE)
                     + r'(?:["\s]|$)', content, re.MULTILINE):
            if STORAGE_FILE not in patch_paths(content):
                raise ValueError("Unsupported predecessor path change")
            args = ["git", "apply", "--include=" + STORAGE_FILE]
            run([*args, "--check", str(path)], tree)
            run([*args, str(path)], tree)
            predecessors.append(name)
    patch = directory / STORAGE_PATCH
    run(["git", "apply", "--check", str(patch)], tree)
    run(["git", "apply", str(patch)], tree)
    result = (tree / STORAGE_FILE).read_text()
    block = re.search(r"if \(database_path.empty\(\)\) \{(.*?)\n  \}", result, re.DOTALL)
    if not block or any(value not in block[1] for value in
                        ("base::MayBlock()", "base::WithBaseSyncPrimitives()", "BLOCK_SHUTDOWN")):
        raise ValueError("The in-memory runner does not retain all three task traits")
    return predecessors


def storage(root, tools_root):
    """Check exactly the affected file at the pinned Chromium commit."""
    if not (root / "patches/chromium" / STORAGE_PATCH).exists():
        print("No storage patch on this source head; applicability is not claimed.")
        return
    metadata = json.loads((tools_root / "source-inputs.json").read_text())
    commit = checked_sha(metadata["chromium_commit"])
    with tempfile.TemporaryDirectory(prefix="fork-storage-patch-") as temporary:
        tree = Path(temporary)
        source = tree / STORAGE_FILE
        source.parent.mkdir(parents=True)
        source.write_bytes(fetch(f"https://raw.githubusercontent.com/chromium/chromium/{commit}/{STORAGE_FILE}"))
        predecessors = apply_storage_patch(root, tree)
    print(json.dumps({"chromium_commit": commit, "file": STORAGE_FILE,
                      "ordered_predecessors": predecessors, "patch_applies": True,
                      "scope": "one-file applicability and task traits; no full patch-stack or native claim"}, indent=2))


def main():
    """Dispatch one bounded check against an explicit source checkout."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("matrix", "verify", "setup", "lint", "types", "storage", "state"))
    parser.add_argument("--source-root", type=Path, default=Path.cwd())
    parser.add_argument("--base-sha")
    parser.add_argument("--tools-root", type=Path)
    parser.add_argument("--source-kind", choices=("authentication", "creation", "simplification", "storage", "ci"))
    args = parser.parse_args()
    root = args.source_root.resolve()
    if args.phase == "matrix":
        matrix()
    elif args.phase == "verify":
        if args.source_kind in ("authentication", "creation", "simplification"):
            if (not (root / "script/run-webauthn-hybrid-tests.py").is_file()
                    or "ses.setWebAuthnHybridHandler(handler)" not in
                    (root / "docs/api/session.md").read_text()):
                raise ValueError("Expected authentication API and state runner are missing")
            if args.source_kind in ("creation", "simplification") and (
                    not (root / "spec/fixtures/api/webauthn-hybrid/creation.cjs").is_file()
                    or "* `requestType` string" not in
                    (root / "docs/api/session.md").read_text()):
                raise ValueError("Expected creation fixture and request type are missing")
            if args.source_kind == "simplification" and (
                    "The handler returns no value." not in
                    (root / "docs/api/session.md").read_text()):
                raise ValueError("Expected void handler contract is missing")
        elif args.source_kind == "storage":
            if (STORAGE_PATCH not in patch_registry(root)
                    or not (root / "script/run-storage-shutdown-tests.py").is_file()):
                raise ValueError("Expected storage patch and runner are missing")
        elif args.source_kind != "ci":
            raise ValueError("A source kind is required")
    elif args.phase == "setup":
        setup(root, args.tools_root.resolve())
    elif args.phase == "lint":
        lint(root, checked_sha(args.base_sha))
    elif args.phase == "types":
        types(root)
    elif args.phase == "storage":
        storage(root, args.tools_root.resolve())
    elif (root / "script/run-webauthn-hybrid-tests.py").exists():
        run(["python3", "script/run-webauthn-hybrid-tests.py", "--suite", "state"], root)
    else:
        print("No authentication state test on this source head; no state result claimed.")


if __name__ == "__main__":
    main()
