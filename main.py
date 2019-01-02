import sys
import os
import youtube_dl

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <url(s)>", file=sys.stderr)
        exit(1)

    ydl_opts = {
        'outtmpl': './downloads/%(id)s.%(ext)s'
    }
    with youtube_dl.YoutubeDL(ydl_opts) as ydl:
        ydl.download([*sys.argv[1:]])
