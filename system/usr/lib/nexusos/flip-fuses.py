#!/usr/bin/env python3
"""Turn off Electron features NexusOS never uses, so nothing can abuse them.
Fuse order (Electron FuseV1): 0 RunAsNode, 1 EnableCookieEncryption,
2 EnableNodeOptionsEnvironmentVariable, 3 EnableNodeCliInspectArguments, ..."""
import sys
SENTINEL = b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
WANT = {0: ord('0'), 1: ord('1'), 2: ord('0'), 3: ord('0')}
path = sys.argv[1]
data = bytearray(open(path, 'rb').read())
i = data.find(SENTINEL)
if i < 0 or data.find(SENTINEL, i + 1) >= 0:
    sys.exit('fuse wire not found exactly once in ' + path)
ver, n = data[i + len(SENTINEL)], data[i + len(SENTINEL) + 1]
if ver != 1 or n < 4:
    sys.exit('unexpected fuse wire version %d / length %d' % (ver, n))
start = i + len(SENTINEL) + 2
for k, v in WANT.items():
    if data[start + k] not in (ord('0'), ord('1')):
        sys.exit('fuse %d has unexpected value %r' % (k, chr(data[start + k])))
    data[start + k] = v
open(path, 'wb').write(data)
print('Electron fuses set:', bytes(data[start:start + n]).decode())
