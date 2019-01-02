import subprocess

try:
    ps = subprocess.Popen(('ps', '-u', 'root'), stdout=subprocess.PIPE)
    output = subprocess.check_output(('grep', 'node'), stdin=ps.stdout)
    ps.wait()

    if output.decode('utf-8').count('node') < 1:
        raise Exception()
except:
    subprocess.Popen(['/usr/bin/node', '/home/pi/srv/YTDLBOT/main.js'])