from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from pathlib import Path
import hashlib
import json
import os
import re


def get_music_directories():
    home = Path.home()
    candidates = []
    env_music = os.environ.get('MUSIC_DIR', '').strip()
    if env_music:
        candidates.append(Path(env_music))
    candidates.extend([
        home / 'Music',
        home / 'Música',
        home / 'OneDrive' / 'Music',
        home / 'OneDrive' / 'Música',
    ])
    valid_dirs, seen = [], set()
    for folder in candidates:
        try:
            resolved = folder.resolve()
            key = str(resolved).lower()
            if resolved.exists() and resolved.is_dir() and key not in seen:
                seen.add(key)
                valid_dirs.append(resolved)
        except OSError:
            continue
    return valid_dirs


def scan_mp3_files(query=''):
    music_dirs = get_music_directories()
    normalized_query = query.strip().lower()
    tracks, seen_paths = [], set()
    for base_dir in music_dirs:
        try:
            for root, _, files in os.walk(base_dir):
                for file_name in files:
                    if not file_name.lower().endswith('.mp3'):
                        continue
                    try:
                        resolved_path = (Path(root) / file_name).resolve()
                        path_key = str(resolved_path).lower()
                        if path_key in seen_paths:
                            continue
                        seen_paths.add(path_key)
                        stat = resolved_path.stat()
                        stem = resolved_path.stem
                        rel_parent = resolved_path.parent.relative_to(base_dir)
                        folder_name = 'Música' if str(rel_parent) == '.' else str(rel_parent).replace('\\', '/')
                        if normalized_query and normalized_query not in stem.lower() and normalized_query not in folder_name.lower():
                            continue
                        track_id = hashlib.sha1(path_key.encode('utf-8')).hexdigest()[:16]
                        tracks.append({
                            'id': track_id,
                            'title': stem,
                            'filename': resolved_path.name,
                            'folder': folder_name,
                            'size': stat.st_size,
                            'url': f'/api/music/file?id={track_id}',
                            '_path': str(resolved_path)
                        })
                    except OSError:
                        continue
        except OSError:
            continue
    tracks.sort(key=lambda item: item['title'].lower())
    return tracks, [str(d) for d in music_dirs]



class AppHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed_url = urlparse(self.path)
        if parsed_url.path in ('/api/music', '/api/search'):
            query = parse_qs(parsed_url.query).get('q', [''])[0].strip()
            tracks, directories = scan_mp3_files(query)
            public_tracks = [{k: v for k, v in t.items() if k != '_path'} for t in tracks]
            self.send_json({'ok': True, 'directories': directories, 'items': public_tracks})
            return

        if parsed_url.path == '/api/music/file':
            track_id = parse_qs(parsed_url.query).get('id', [''])[0].strip()
            if not track_id:
                self.send_json({'error': 'Falta el ID del archivo MP3'}, 400)
                return
            tracks, _ = scan_mp3_files()
            match = next((t for t in tracks if t['id'] == track_id), None)
            if not match or not os.path.isfile(match['_path']):
                self.send_json({'error': 'Archivo MP3 no encontrado'}, 404)
                return
            self.serve_mp3_file(match['_path'])
            return

        super().do_GET()

    def serve_mp3_file(self, file_path):
        try:
            file_size = os.path.getsize(file_path)
            range_header = self.headers.get('Range')
            start, end, status = 0, file_size - 1, 200
            if range_header:
                m = re.match(r'bytes=(\d*)-(\d*)', range_header)
                if m:
                    s_str, e_str = m.groups()
                    if s_str:
                        start = int(s_str)
                    if e_str:
                        end = int(e_str)
                    if start >= file_size:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{file_size}')
                        self.end_headers()
                        return
                    end = min(end, file_size - 1)
                    status = 206

            length = end - start + 1
            self.send_response(status)
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(length))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
            self.end_headers()

            with open(file_path, 'rb') as audio_file:
                audio_file.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = audio_file.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self.send_json({'error': 'No se pudo leer el archivo MP3'}, 500)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5500'))
    ThreadingHTTPServer(('0.0.0.0', port), AppHandler).serve_forever()
