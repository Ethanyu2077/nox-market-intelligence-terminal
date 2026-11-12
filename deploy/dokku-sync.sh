#!/usr/bin/env bash
# bash deploy/dokku-sync.sh [--check | --verify] <release commit SHA>
# --check is entirely local. --verify reads the running application without deploying.
set -euo pipefail
usage() { echo "用法: $0 [--check | --verify] <发布提交 SHA>" >&2; exit 2; }
mode=deploy
case "${1:-}" in --check|--verify) mode=${1#--}; shift ;; esac
[[ $# == 1 && "$1" =~ ^[a-fA-F0-9]{7,40}$ ]] || usage
dir=$(cd "$(dirname "$0")" && pwd)
project=$(git -C "$dir" rev-parse --show-toplevel)
repo="$project"
if ! git -C "$repo" rev-parse --verify --quiet "$1^{commit}" >/dev/null; then
  repo="$project/releases/history-sync-recovery"
fi
commit=$(git -C "$repo" rev-parse --verify "$1^{commit}")
if [[ $mode == check ]]; then
  git -C "$repo" show --no-patch --format='本地发布提交 %H %s' "$commit"
  exit 0
fi

host=ubuntu@18.163.159.17
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10)
remote() { ssh "${ssh_opts[@]}" "$host" "$@"; }
ctl() { remote sudo -n dokku "$@"; }
rotation() { git -C "$repo" show "$commit:deploy/dokku-log-rotation.py" | remote python3 - "$1"; }
mounts() {
  remote bash -s <<'MOUNTS'
set -eu
names=$(sudo -n docker ps --filter label=com.dokku.app-name=ans --filter label=com.dokku.process-type=web --format '{{.Names}}')
[[ "$names" == ans.web.1 ]] || { echo "运行中的 ans web 实例: ${names:-无}。需要单个写入进程。" >&2; exit 1; }
live=$(sudo -n docker inspect --format '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' ans.web.1)
for pair in 'data /app/.data' 'auth /app/var/auth'; do
  grep -Fxq "/var/lib/dokku/data/storage/ans/$pair true" <<< "$live" || { echo "缺少持久化读写挂载 $pair" >&2; exit 1; }
done
MOUNTS
}

restore_checks=0
cleanup() {
  local rc=$?
  if (( restore_checks )); then
    if ! ctl checks:enable ans web; then rc=1; fi
    if [[ "$skipped" != none && -n "$skipped" ]]; then
      if ! ctl checks:skip ans "$skipped"; then rc=1; fi
    fi
    if [[ "$disabled" != none && -n "$disabled" ]]; then
      if ! ctl checks:disable ans "$disabled"; then rc=1; fi
    fi
    local actual_disabled actual_skipped
    actual_disabled=$(ctl checks:report ans --checks-disabled-list) || rc=1
    actual_skipped=$(ctl checks:report ans --checks-skipped-list) || rc=1
    if [[ "$actual_disabled" != "$disabled" || "$actual_skipped" != "$skipped" ]]; then
      echo "检查策略恢复失败。原 disabled=$disabled skipped=$skipped；现 disabled=$actual_disabled skipped=$actual_skipped" >&2
      rc=1
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

if [[ $mode == deploy ]]; then
  branch=$(ctl git:report ans --git-computed-deploy-branch)
  git check-ref-format "refs/heads/$branch"
  target=$(git -C "$project" remote get-url --push dokku)
  push=(git -C "$repo" -c 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10' push)
  destination=("$target" "$commit:refs/heads/$branch")
  if result=$(LC_ALL=C "${push[@]}" --dry-run "${destination[@]}" 2>&1); then
    printf '%s\n' "$result"
  else
    printf '%s\n' "$result" >&2
    if ! grep -Eiq 'Permission denied \([^)]*(publickey|password)|Authentication failed|No supported authentication methods available' <<< "$result"; then exit 1; fi
    echo 'Dokku Git 身份验证未通过，使用现有 Ubuntu 登录重试普通快进推送。' >&2
    push+=('--receive-pack=sudo -n dokku git-receive-pack')
    destination=("$host:ans" "$commit:refs/heads/$branch")
    "${push[@]}" --dry-run "${destination[@]}"
  fi
  deployed=$(ctl git:report ans --git-sha)
  mounts
  log_action=$(rotation prepare)
  if [[ ! "$deployed" =~ ^[[:xdigit:]]{7,40}$ || "$commit" != "$deployed"* || "$log_action" == recreate ]]; then
    disabled=$(ctl checks:report ans --checks-disabled-list)
    skipped=$(ctl checks:report ans --checks-skipped-list)
    # Only standard Dokku process names may be passed back through the SSH shell.
    [[ "$disabled" =~ ^[a-zA-Z0-9_.,-]*$ && "$skipped" =~ ^[a-zA-Z0-9_.,-]*$ ]] || { echo '检查策略格式无法识别' >&2; exit 1; }
    if [[ ! ",$disabled," =~ ,(_all_|web), ]]; then
      restore_checks=1
      ctl checks:disable ans web
    fi
    if [[ "$log_action" == recreate && "$deployed" =~ ^[[:xdigit:]]{7,40}$ && "$commit" == "$deployed"* ]]; then
      ctl ps:restart ans
    else
      "${push[@]}" "${destination[@]}"
    fi
  fi
fi

deployed=$(ctl git:report ans --git-sha)
[[ "$deployed" =~ ^[[:xdigit:]]{7,40}$ && "$commit" == "$deployed"* ]] || { echo "线上 SHA $deployed 与发布提交 $commit 不符" >&2; exit 1; }
mounts
remote df -h / /var/lib/docker /var/lib/dokku/data/storage/ans
rotation verify
# After startup the server measures pending bytes every 15 seconds. Use consecutive fresh
# samples and durable progress rather than treating a healthy HTTP listener as replication.
for (( attempt=0; attempt<30; attempt++ )); do
  if remote sudo -n docker exec ans.web.1 node -e "'fetch(\"http://127.0.0.1:\"+(process.env.PORT||3000)+\"/api/health\",{signal:AbortSignal.timeout(3000)}).then(async r=>process.exit(r.ok&&(await r.json()).status===\"ok\"?0:1)).catch(()=>process.exit(1))'"; then break; fi
  sleep 3
done
remote sudo -n docker exec -i ans.web.1 node --input-type=module - <<'PROBE'
const base = 'http://127.0.0.1:' + (process.env.PORT || 3000);
const read = async path => {
  const response = await fetch(base + path, {signal: AbortSignal.timeout(10_000)});
  if (!response.ok) throw Error(path + ' HTTP ' + response.status);
  return response.json();
};
if ((await read('/api/health')).status !== 'ok') throw Error('API health check failed');
let previous, progress = false, issues = new Set(), latest;
for (let i = 0; i < 10; i++) {
  const ops = await read('/api/operations');
  const s = ops.storage, mem = ops.process?.memoryBytes;
  if (!mem || ![mem.heapUsed, mem.rss].every(x => Number.isFinite(x) && x > 0))
    throw Error('运行进程缺少 heapUsed / RSS 遥测');
  const cap = s?.capacity;
  if (!cap || ![cap.pendingBytes, cap.checkedAt, cap.freeBytes, s.databaseRowsAcknowledged, s.retention?.ackCacheBytes].every(Number.isFinite))
    throw Error('缺少 journal 检查点或待同步字节数');
  const budgets = [s.outcomes, s.orderFlow, s.marketCache];
  latest = {pid: ops.process.pid, started: ops.process.startedAt, rss: mem.rss, heapUsed: mem.heapUsed,
    connected: s.connected, backend: s.queryBackend, pending: cap.pendingBytes, measured: cap.checkedAt,
    journalBytes: s.retention.journalBytes, journalMax: s.retention.maxBytes, retiredBytes: s.retention.retiredBytes,
    ackBytes: cap.acknowledgedFileBytes, ackTarget: s.retention.ackCacheBytes, freeBytes: cap.freeBytes,
    byKind: cap.byKind, diskOk: cap.freeBytes >= s.retention.reserveBytes &&
      s.retention.journalBytes + s.retention.stagingBytes <= s.retention.maxBytes &&
      Number.isFinite(cap.acknowledgedFileBytes) && cap.acknowledgedFileBytes <= s.retention.ackCacheBytes &&
      budgets.every(b => Number.isFinite(b?.bytes) && b.bytes <= b.maxBytes) &&
      Number.isFinite(s.timescaleRetention?.measuredBytes) && s.timescaleRetention.measuredBytes <= s.timescaleRetention.maxBytes,
    acknowledged: s.databaseRowsAcknowledged, refused: s.retention?.refusedRows,
    historyWrites: s.writes, orderFlowWrites: s.orderFlow?.writes,
    syncError: s.error, quotaPause: s.timescaleRetention?.paused, retentionError: s.retention?.error};
  console.log(JSON.stringify(latest));
  if (latest.syncError?.startsWith('Journal recovery pending')) issues.add(latest.syncError);
  if (previous && previous.started !== latest.started) throw Error('采样期间服务重启，请重新验证');
  if (previous && latest.connected && (latest.acknowledged > previous.acknowledged ||
      (latest.measured > previous.measured && latest.pending < previous.pending))) progress = true;
  const healthy = latest.connected && latest.backend === 'timescaledb' && !latest.quotaPause && !latest.retentionError;
  if (healthy && previous?.diskOk && latest.diskOk && !latest.syncError && !previous.syncError && latest.pending === 0 &&
      previous.pending === 0 && latest.measured > previous.measured && !issues.size) {
    console.log('同步已追平，两次采样均无积压且应用存储已回到预算内。'); process.exit(0);
  }
  if (i < 9) { previous = latest; await new Promise(resolve => setTimeout(resolve, 5_000)); }
}
if (issues.size) {
  console.error('有待修复的日志分区，' + (progress ? '其他数据已推进。' : '观察期内未确认推进。'));
  for (const message of issues) console.error(message);
  process.exit(2);
}
if (latest.diskOk && latest.connected && latest.backend === 'timescaledb' && !latest.quotaPause && !latest.retentionError &&
    (!latest.syncError || latest.syncError.includes('catching up')) && progress) {
  console.log('同步正在推进，观察期内未确认积压持续为零。'); process.exit(0);
}
console.error('尚未核实同步推进。请按上方数据库连接、积压、配额和错误字段排查，再运行 --verify。');
process.exit(1);
PROBE
