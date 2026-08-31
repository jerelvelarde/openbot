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
# NOT RECURSIVE, deliberately. Chowning the mount point is what unblocks writes into it, and a
# freshly mounted volume is empty, so there is nothing underneath to fix. `chown -R` would instead
# walk a workspace that may hold a checked-out repository and gigabytes of build output, on every
# single boot, to correct ownership that is already right. The one case recursion would repair — a
# volume already populated while root-owned — cannot arise if this ships before the volume is
# mounted, which is the order it is meant to ship in.
#
# A no-op without a volume: chowning a directory already owned by `pwuser` costs nothing, so this
# needs no switch and cannot drift out of step with whether a volume is attached.
set -eu

for dir in "${WORKSPACE_DIR:-/workspace}" "${PROFILES_DIR:-/profiles}"; do
  # Created if the mount brought nothing, so the chown below has something to act on.
  [ -d "$dir" ] || mkdir -p "$dir"
  chown pwuser:pwuser "$dir"
done
