#!/bin/bash
set -e

if [[ ! -d "/Applications/Synax.app" ]]; then
  printf '请先将 Synax.app 拖入“应用程序”文件夹，再运行此脚本。\n' >&2
  exit 1
fi

printf '将移除 /Applications/Synax.app 的下载隔离标记，可能需要输入管理员密码。\n'
sudo xattr -rd com.apple.quarantine /Applications/Synax.app
printf '完成。现在可以打开 Synax。\n'
