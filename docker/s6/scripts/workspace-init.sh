#!/command/with-contenv sh
# Give a Bot back its own workspace when a platform volume is mounted over it.
#
# The image creates /workspace and /profiles and chowns them to `pwuser` at BUILD time. A volume
# mounted at either path at RUN time hides that completely: the mount arrives owned by root, and
# nothing in the image puts the ownership back. The browser and the file tools run as `pwuser`, so
# the first write fails with EACCES on a directory that looks perfectly correct from the outside —
# and the failure surfaces as a Bot that cannot save a file, not as a permissions problem.
#
# THIS IS THE HAZARD `postgres-init` ALREADY EXISTS FOR, one directory along. Its own comment says
# it: a volume mounted over /var/lib/postgresql "arrives owned by root, `data` is not in it, and
# nothing else in the image puts either back". There is no `fix-attrs.d` under `docker/s6`, so the
# built-in s6-overlay service of that name has nothing to act on. A oneshot whose `up` runs as root
# is the only thing in a position to fix it: every service that needs these directories has already
# dropped to `pwuser` by the time it starts.
#
# ONLY WHERE THIS CONTAINER RUNS THE BROWSER. `computer/run` exits 0 immediately when
# `EMBEDDED_COMPUTER` is off, because the API is reaching a computer somewhere else. On such a
# deployment nothing in this container writes to either directory, and a failure here would take the
# API down over storage it does not use. Read from the same switch, so the two cannot disagree.
#
# NOT RECURSIVE. A fresh ext4 volume is not empty — `docs/deployment.md` says so, and it is why
# postgres wants the parent rather than the data directory: "the mount arrives holding a
# `lost+found` directory". That one is root-owned and stays so, which is harmless, because `pwuser`
# owns the parent and never needs to write inside it. What recursion would buy is fixing children
# this script did not create; what it would cost is walking a workspace holding a checked-out
# repository and gigabytes of build output, on every boot, to correct ownership already correct.
set -eu

if [ "${EMBEDDED_COMPUTER:-on}" != "on" ]; then
  exit 0
fi

# Read rather than hardcoded, and `computer/run` no longer exports its own: two places naming the
# same directory differently is how this ends up chowning something nothing uses. See that file.
for dir in "${WORKSPACE_DIR:-/workspace}" "${PROFILES_DIR:-/profiles}"; do
  # NOT `mkdir -p`. The image creates both at build time, so a missing directory means the variable
  # names a path this image does not have — and creating it would chown somewhere harmless while
  # leaving the real mount root-owned, reporting success at the very moment it had failed.
  if [ ! -d "$dir" ]; then
    echo "workspace-init: $dir is not a directory." >&2
    echo "workspace-init: the image creates the workspace and profiles directories, so this means WORKSPACE_DIR or PROFILES_DIR names a path this image does not have. Nothing was changed, and the browser will not start." >&2
    exit 1
  fi

  # Said out loud, because s6 does not stop the container for a failed oneshot: the default for
  # S6_BEHAVIOUR_IF_STAGE2_FAILS is to carry on. Without this the operator gets one `chown:` line, no
  # `computer` and no `api` — which `api` inherits transitively — and a URL that serves nothing with
  # nothing to explain why. This is the same failure postgres-init spends two paragraphs preventing.
  chown pwuser:pwuser "$dir" || {
    echo "workspace-init: could not give $dir to pwuser." >&2
    echo "workspace-init: the browser and the file tools run as pwuser and cannot write there, so neither computer nor api will start. Check the platform is not mounting it read-only." >&2
    exit 1
  }
done
