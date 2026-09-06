"""Stage complete Debian 13 runtime packages with their inventory and file provenance.

The builder digest identifies the immutable package contents we copy. Its publisher
provenance is reviewed separately; this script is not an image-signature verifier.
"""
import hashlib, json, pathlib, shutil, subprocess
root=pathlib.Path('/runtime')
packages=['libffi8','libbz2-1.0','liblzma5']
manifest=[]
for package in packages:
    status=subprocess.check_output(['dpkg-query','-s',package],text=True)
    fields=dict(line.split(': ',1) for line in status.splitlines() if ': ' in line and not line.startswith(' '))
    records=[]
    for line in subprocess.check_output(['dpkg-query','-L',package],text=True).splitlines():
        source=pathlib.Path(line)
        if not source.is_absolute() or ".." in source.parts:
            raise ValueError("Unexpected Debian package path")
        destination=root/line.lstrip('/')
        if source.is_symlink():
            destination.parent.mkdir(parents=True,exist_ok=True)
            if not destination.exists(): destination.symlink_to(source.readlink())
            records.append({'path':line,'symlink':str(source.readlink())})
        elif source.is_file():
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source,destination)
            records.append({'path':line,'sha256':hashlib.sha256(source.read_bytes()).hexdigest()})
        elif source.is_dir(): destination.mkdir(parents=True,exist_ok=True)
    dest=root/'var/lib/dpkg/status.d'/package
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(status)
    manifest.append({'name':fields['Package'],'version':fields['Version'],'architecture':fields['Architecture'],'source':fields.get('Source',fields['Package']),'files':records})
p=root/'usr/share/agent-notepad/runtime-packages.json'
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps({'builder_image':'python:3.12.14-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea','packages':manifest},indent=2))
