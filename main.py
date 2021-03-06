import sys
import os
import youtube_dl

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(
            f"Usage: {sys.argv[0]} <resolution: 240|360|480|720|1080> <url(s)>", file=sys.stderr)
        exit(1)

    ydl_opts = {
        'outtmpl': './downloads/%(id)s.%(ext)s',
        'format': 'best[height<=' + sys.argv[1] + ']'
        # 'format': 'best[filesize<50M]'
    }
    with youtube_dl.YoutubeDL(ydl_opts) as ydl:
        ydl.download([*sys.argv[2:]])
