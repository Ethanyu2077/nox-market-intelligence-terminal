"""Limit the ans web container's local Docker logs. Run on the Dokku host."""
import json
import re
import shlex
import subprocess
import sys


def command(*args):
    return subprocess.check_output(["sudo", "-n", *args], text=True).strip()


def positive_size(value):
    return bool(re.fullmatch(r"[1-9][0-9]*(?:[kmg]i?b?|b)?", value, re.I))


def validate_current(config):
    driver = config["Type"]
    options = config.get("Config") or {}
    if driver not in ("json-file", "local"):
        print(f"ans.web.1 log driver: {driver}; retention is managed by that backend.", file=sys.stderr)
        return True
    size = options.get("max-size", "20m" if driver == "local" else "-1")
    count = options.get("max-file", "5" if driver == "local" else "1")
    print(f"ans.web.1 log driver: {driver}, max-size={size}, max-file={count}", file=sys.stderr)
    return positive_size(size) and bool(re.fullmatch(r"[1-9][0-9]*", count))


def size_options(report):
    words = shlex.split(report)
    for i, word in enumerate(words):
        if word == "--log-opt" and i + 1 < len(words):
            flag = word + " " + words[i + 1]
            option = words[i + 1]
        elif word.startswith("--log-opt="):
            flag = word
            option = word.partition("=")[2]
        else:
            continue
        if option.startswith("max-size="):
            yield flag, option.partition("=")[2]


def prepare():
    # Preserve any smaller size already configured for the next container, including
    # process-specific deploy options. Remove only explicit unbounded overrides.
    settings = command("dokku", "docker-options:report", "ans")
    staged_limit = False
    for line in settings.splitlines():
        match = re.match(r"\s*Docker options deploy(\.web)?:\s*(.*)$", line, re.I)
        if match:
            scope = ["--process", "web"] if match[1] else []
            for flag, value in size_options(match[2]):
                if value == "-1":
                    command("dokku", "docker-options:remove", *scope, "ans", "deploy", flag)
                elif positive_size(value):
                    staged_limit = True
    try:
        size = command("dokku", "logs:report", "ans", "--logs-computed-max-size")
    except subprocess.CalledProcessError:
        # Older Dokku versions may only expose the docker-options plugin.
        if not staged_limit:
            command("dokku", "docker-options:add", "ans", "deploy", "--log-opt max-size=10m")
        return
    if not positive_size(size) and not staged_limit:
        command("dokku", "logs:set", "ans", "max-size", "10m")


if __name__ == "__main__":
    mode, = sys.argv[1:]
    if mode not in ("prepare", "verify"):
        sys.exit("Expected prepare or verify")
    live = json.loads(command("docker", "inspect", "--format", "{{json .HostConfig.LogConfig}}", "ans.web.1"))
    if validate_current(live):
        print("ready")
    elif mode == "prepare":
        prepare()
        print("recreate")
    else:
        sys.exit("The running ans.web.1 container still has unbounded Docker logs.")
