#!/usr/bin/env bash
# 为所有「有 tag、但没有 GitHub Release」的版本补建 Release。
# 正文自动从 CHANGELOG.md 取该版本段落。★不依赖 GitHub Actions★
#
# 特点：可以在任何目录直接跑，不需要先 clone 仓库——
#   · 若当前目录有 CHANGELOG.md / 是 git 仓库，就用本地的；
#   · 否则自动从 GitHub 拉 tag 列表和 CHANGELOG.md。
#
# 用法（token 只从环境变量读，不要写进命令历史以外的文件，也不要贴到聊天里）：
#   export GITHUB_TOKEN=ghp_xxx          # 需 Contents: Read and write（经典 token 用 repo）
#   bash backfill-releases.sh            # 补全部缺失的（推荐）
#   bash backfill-releases.sh v1.9.2     # 只补指定版本（可多个）
#   DRY_RUN=1 bash backfill-releases.sh  # 只看会建哪些、正文长啥样，不真建
set -euo pipefail

REPO="${REPO:-cnrock/h3-studio}"
BRANCH="${BRANCH:-main}"
API="https://api.github.com/repos/$REPO"
if [ -z "${GITHUB_TOKEN:-}" ]; then echo "缺少 token：请先 export GITHUB_TOKEN=... （需 Contents: Read and write）" >&2; exit 1; fi
DRY_RUN="${DRY_RUN:-0}"

command -v curl >/dev/null || { echo "需要 curl"; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3（解析 JSON 用）"; exit 1; }

api() { curl -sS -m 30 -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" "$@"; }

# ---- 1) 找到 CHANGELOG 内容（本地优先，否则从 GitHub 拉）----
CL_FILE=""
if [ -f CHANGELOG.md ]; then
  CL_FILE="CHANGELOG.md"; echo "使用本地 CHANGELOG.md"
else
  CL_FILE="$(mktemp)"
  curl -fsSL -m 30 "https://raw.githubusercontent.com/$REPO/$BRANCH/CHANGELOG.md" -o "$CL_FILE" \
    || { echo "拉取 CHANGELOG.md 失败"; exit 1; }
  echo "已从 GitHub 拉取 CHANGELOG.md"
fi

# ---- 2) 确定要处理的 tag 列表 ----
if [ "$#" -gt 0 ]; then
  TAGS=("$@")
elif git rev-parse --git-dir >/dev/null 2>&1; then
  mapfile -t TAGS < <(git tag -l 'v*' --sort=v:refname)
  echo "使用本地 git tag"
else
  RAW="$(api "$API/tags?per_page=100")" || true
  if ! TAGLIST="$(printf '%s' "$RAW" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.stderr.write("tag 列表返回的不是 JSON\n"); sys.exit(1)
if isinstance(d, dict):
    sys.stderr.write("GitHub API 出错：" + str(d.get("message") or d) + "\n"); sys.exit(1)
for t in d:
    print(t["name"])
')"; then
    echo "----" >&2
    echo "无法从 GitHub 获取 tag 列表（见上面的 API 出错信息）。" >&2
    echo "· 检查 token 是否有效、是否对该仓库有 Contents: Read 权限；" >&2
    echo "· 或直接点名版本，绕过列表：bash backfill-releases.sh v0.1 v0.2 v0.3 ..." >&2
    exit 1
  fi
  mapfile -t TAGS < <(printf '%s\n' "$TAGLIST" | grep -E '^v[0-9]' | sort -V)
  echo "已从 GitHub 拉取 tag 列表（共 ${#TAGS[@]} 个）"
fi

notes_for() {  # $1=tag
  awk -v tag="$1" '
    /^##[ \t]/ {
      if (grab) exit
      line=$0; sub(/^##[ \t]+/, "", line)
      n=split(line, a, /[ \t]/)
      if (n>0 && a[1]==tag) { grab=1; next }
    }
    grab { print }
  ' "$CL_FILE"
}

created=0; skipped=0; failed=0
for TAG in "${TAGS[@]}"; do
  [ -z "$TAG" ] && continue
  code=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" \
         -H "Authorization: Bearer $GITHUB_TOKEN" "$API/releases/tags/$TAG" || echo 000)
  if [ "$code" = "200" ]; then
    echo "跳过（已有 Release）: $TAG"; skipped=$((skipped+1)); continue
  fi

  body=$(notes_for "$TAG")
  [ -n "$body" ] || body="（CHANGELOG.md 未找到 $TAG 段落，正文留空）"

  if [ "$DRY_RUN" = "1" ]; then
    echo "== [DRY] 将创建 $TAG =="; printf '%s\n' "$body" | head -4; echo "..."
    created=$((created+1)); continue
  fi

  payload=$(BODY="$body" TAG="$TAG" python3 -c 'import json,os;print(json.dumps({"tag_name":os.environ["TAG"],"name":os.environ["TAG"]+" 更新","body":os.environ["BODY"],"draft":False,"prerelease":False}))')
  resp=$(api -X POST "$API/releases" -d "$payload")
  url=$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html_url") or "")' 2>/dev/null || true)
  if [ -n "$url" ]; then
    echo "已创建 $TAG -> $url"; created=$((created+1))
  else
    echo "失败 $TAG: $(printf '%s' "$resp" | head -c 300)"; failed=$((failed+1))
  fi
done

echo "----"
echo "新建 $created · 跳过 $skipped · 失败 $failed"
[ "$failed" -eq 0 ]
