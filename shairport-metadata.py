#!/usr/bin/env python3
# Python 3 port of MMM-ShairportMetadata's shairport-metadata.py
# Reads the shairport-sync metadata pipe on stdin and emits JSON lines.
import re, sys
import base64
import binascii
import json


def start_item(line):
    regex = r"<item><type>(([A-Fa-f0-9]{2}){4})</type><code>(([A-Fa-f0-9]{2}){4})</code><length>(\d*)</length>"
    matches = re.findall(regex, line)
    typ = bytes.fromhex(matches[0][0]).decode('ascii')
    code = bytes.fromhex(matches[0][2]).decode('ascii')
    length = int(matches[0][4])
    return (typ, code, length)


def start_data(line):
    try:
        assert line == '<data encoding="base64">\n'
    except AssertionError:
        if line.startswith("<data"):
            return 0
        return -1
    return 0


def read_data(line, length):
    b64size = 4 * ((length + 2) // 3)
    try:
        data = base64.b64decode(line[:b64size])
    except (binascii.Error, ValueError):
        data = b""
    return data


def guessImageMime(magic):
    if magic.startswith(b'\xff\xd8'):
        return 'image/jpeg'
    elif magic.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    else:
        return "image/jpg"


def text(data):
    return data.decode('utf-8', 'replace')


if __name__ == "__main__":
    metadata = {}
    while True:
        line = sys.stdin.readline()
        if not line:  # EOF
            break
        sys.stdout.flush()
        if not line.startswith("<item>"):
            continue
        typ, code, length = start_item(line)
        data = b""
        if length > 0:
            r = start_data(sys.stdin.readline())
            if r == -1:
                continue
            data = read_data(sys.stdin.readline(), length)

        # Everything read
        if typ == "core":
            if code == "asal":
                metadata['Album Name'] = text(data)
            elif code == "asar":
                metadata['Artist'] = text(data)
            elif code == "minm":
                metadata['Title'] = text(data)

        if typ == "ssnc" and code == "snam":
            metadata['snam'] = text(data)
        if typ == "ssnc" and code == "prgr":
            metadata['prgr'] = text(data)
        if typ == "ssnc" and code == "pfls":
            metadata = {}
            print(json.dumps({}))
            sys.stdout.flush()
        if typ == "ssnc" and code == "pend":
            metadata = {}
            print(json.dumps({}))
            sys.stdout.flush()
        if typ == "ssnc" and code == "prsm":
            metadata['pause'] = False
        if typ == "ssnc" and code == "pbeg":
            metadata['pause'] = False
        if typ == "ssnc" and code == "PICT":
            if len(data) == 0:
                print(json.dumps({"image": ""}))
            else:
                mime = guessImageMime(data)
                print(json.dumps({"image": "data:" + mime + ";base64," + base64.b64encode(data).decode('ascii')}))
            sys.stdout.flush()
        if typ == "ssnc" and code == "mden":
            print(json.dumps(metadata))
            sys.stdout.flush()
            metadata = {}