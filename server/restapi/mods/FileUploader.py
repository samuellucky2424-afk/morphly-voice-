import os
from fastapi import UploadFile


MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_UPLOAD_CHUNKS = 2048


def sanitize_filename(filename: str) -> str:
    if not isinstance(filename, str):
        raise ValueError("Upload filename must be text.")
    safe_filename = filename.strip()
    if not safe_filename or safe_filename in {".", ".."}:
        raise ValueError("Upload filename is empty.")
    if os.path.basename(safe_filename) != safe_filename or "/" in safe_filename or "\\" in safe_filename:
        raise ValueError("Upload filename must not contain a path.")

    max_length = 255
    if len(safe_filename) > max_length:
        file_root, file_ext = os.path.splitext(safe_filename)
        safe_filename = file_root[: max_length - len(file_ext)] + file_ext

    return safe_filename


def upload_file(upload_dirname: str, file: UploadFile, filename: str):
    if file and filename:
        fileobj = file.file
        filename = sanitize_filename(filename)
        target_path = os.path.join(upload_dirname, filename)
        target_dir = os.path.dirname(target_path)
        os.makedirs(target_dir, exist_ok=True)
        written = 0
        try:
            with open(target_path, "wb+") as upload_dir:
                while True:
                    block = fileobj.read(1024 * 1024)
                    if not block:
                        break
                    written += len(block)
                    if written > MAX_UPLOAD_CHUNK_BYTES:
                        raise ValueError("Upload chunk exceeds the 8 MB limit.")
                    upload_dir.write(block)
        except Exception:
            if os.path.exists(target_path):
                os.remove(target_path)
            raise

        return {"status": "OK", "msg": f"uploaded files {filename} "}
    return {"status": "ERROR", "msg": "uploaded file is not found."}


def concat_file_chunks(upload_dirname: str, filename: str, chunkNum: int, dest_dirname: str):
    filename = sanitize_filename(filename)
    if not isinstance(chunkNum, int) or isinstance(chunkNum, bool) or chunkNum < 1 or chunkNum > MAX_UPLOAD_CHUNKS:
        raise ValueError(f"Upload must contain between 1 and {MAX_UPLOAD_CHUNKS} chunks.")
    target_path = os.path.join(upload_dirname, filename)
    target_dir = os.path.dirname(target_path)
    os.makedirs(target_dir, exist_ok=True)
    if os.path.exists(target_path):
        os.remove(target_path)
    chunk_paths = [os.path.join(upload_dirname, f"{filename}_{i}") for i in range(chunkNum)]
    if any(not os.path.isfile(chunk_path) for chunk_path in chunk_paths):
        raise ValueError("One or more upload chunks are missing.")
    total_size = sum(os.path.getsize(chunk_path) for chunk_path in chunk_paths)
    if total_size <= 0 or total_size > MAX_UPLOAD_FILE_BYTES:
        raise ValueError("Combined upload must be between 1 byte and 2 GB.")
    try:
        with open(target_path, "ab") as out:
            for chunk_file_path in chunk_paths:
                with open(chunk_file_path, "rb") as stored_chunk_file:
                    while True:
                        block = stored_chunk_file.read(1024 * 1024)
                        if not block:
                            break
                        out.write(block)
                os.remove(chunk_file_path)
    except Exception:
        if os.path.exists(target_path):
            os.remove(target_path)
        raise
    return {"status": "OK", "msg": f"assembled file {filename}"}
