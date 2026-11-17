#!/usr/bin/env python3
# 调度台的更新程序（以 root 运行，由 dispatch-update.path 在看到"请更新"的条子时启动）。
# 做的事：从 GitHub 仓库下载最新代码 → 检查文件齐全、语法没问题 → 备份现在的版本 → 替换 → 重启调度台
#        → 确认新版本能正常打开；打不开就自动换回旧版本。
# 只更新调度台本体的几个代码文件；config.json、密码、密钥、运行记录一概不动。
import json, os, re, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request

APP = '/opt/dispatch'
STATE = '/var/lib/private/dispatch'
REQ = os.path.join(STATE, 'update-request')
STATUS = os.path.join(STATE, 'update-status.json')
BACKUPS = '/root/dispatch-backups'
FILES = ['server.js', 'index.html', 'login.html', 'ext-review.js', 'voice.js', 'update.js', 'version.json']
info = {'from': '', 'to': ''}


def version(d):
    try:
        return str(json.load(open(os.path.join(d, 'version.json'), encoding='utf-8'))['version'])
    except Exception:
        return '未知'


def status(state, message):
    tmp = STATUS + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'state': state, 'message': message, 'at': int(time.time() * 1000), **info}, f, ensure_ascii=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, STATUS)
    print('[%s] %s' % (state, message), flush=True)


def healthy():
    # 登录页能打开，就说明调度台起来了。
    for _ in range(20):
        time.sleep(2)
        try:
            with urllib.request.urlopen('http://127.0.0.1:4780/login', timeout=5) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
    return False


def put(src_dir, names):
    for n in names:
        tmp = os.path.join(APP, '.' + n + '.new')
        shutil.copyfile(os.path.join(src_dir, n), tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, os.path.join(APP, n))


def main():
    if not os.path.exists(REQ):
        return
    os.remove(REQ)
    info['from'] = version(APP)
    work = tempfile.mkdtemp(prefix='dispatch-update-')
    try:
        cfg = json.load(open(os.path.join(APP, 'config.json'), encoding='utf-8')).get('update') or {}
        repo, branch = str(cfg.get('repo') or ''), str(cfg.get('branch') or 'main')
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo) or not re.fullmatch(r'[\w.-]+', branch):
            return status('failed', '还没有配置更新来源')
        status('running', '正在从 GitHub 下载新版本')
        tgz = os.path.join(work, 'r.tgz')
        req = urllib.request.Request('https://codeload.github.com/%s/tar.gz/refs/heads/%s' % (repo, branch), headers={'User-Agent': 'dispatch-updater'})
        with urllib.request.urlopen(req, timeout=120) as r, open(tgz, 'wb') as f:
            shutil.copyfileobj(r, f)
        with tarfile.open(tgz) as t:
            t.extractall(work, filter='data')
        tops = [d for d in os.listdir(work) if os.path.isdir(os.path.join(work, d))]
        if len(tops) != 1:
            return status('failed', '下载下来的内容不对')
        src = os.path.join(work, tops[0])
        info['to'] = version(src)

        status('running', '正在检查新版本的文件')
        for n in FILES:
            p = os.path.join(src, n)
            if not os.path.isfile(p) or os.path.getsize(p) == 0:
                return status('failed', '新版本里缺少文件：' + n)
            if n.endswith('.js') and subprocess.run(['node', '--check', p], capture_output=True).returncode != 0:
                return status('failed', '新版本的 ' + n + ' 有语法错误，没有更新')
        if info['to'] == '未知':
            return status('failed', '新版本没有版本号，没有更新')

        backup = os.path.join(BACKUPS, time.strftime('%Y%m%d-%H%M%S') + '-v' + info['from'])
        os.makedirs(backup, mode=0o700)
        had = [n for n in FILES if os.path.exists(os.path.join(APP, n))]
        for n in had:
            shutil.copy2(os.path.join(APP, n), os.path.join(backup, n))

        status('running', '正在替换文件并重启调度台')
        put(src, FILES)
        subprocess.run(['systemctl', 'restart', 'dispatch'])
        if healthy():
            status('done', '已经更新到 v%s' % info['to'])
        else:
            put(backup, had)
            for n in FILES:
                if n not in had:
                    os.remove(os.path.join(APP, n))
            subprocess.run(['systemctl', 'restart', 'dispatch'])
            ok = healthy()
            status('failed', '新版本启动不了，已经自动换回 v%s%s' % (info['from'], '' if ok else '（换回后仍然没有起来，需要人工检查）'))
        # 只留最近 10 份备份。
        for old in sorted(os.listdir(BACKUPS))[:-10]:
            shutil.rmtree(os.path.join(BACKUPS, old), ignore_errors=True)
    except Exception as e:
        status('failed', '更新出错：' + str(e)[:160])
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
