import hashlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).with_name('linux-package-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class InstalledResourceTests(unittest.TestCase):
    def test_failed_command_exposes_captured_output_and_preserves_exit_code(self):
        diagnostics = io.StringIO()
        with redirect_stderr(diagnostics), self.assertRaises(subprocess.CalledProcessError) as failure:
            smoke.run([sys.executable, '-c',
                       'import sys; print("worker failed frame"); print("native detail", file=sys.stderr); sys.exit(7)'])
        self.assertEqual(failure.exception.returncode, 7)
        self.assertIn('worker failed frame', diagnostics.getvalue())
        self.assertIn('native detail', diagnostics.getvalue())

    def test_successful_command_retains_output_without_error_diagnostics(self):
        diagnostics = io.StringIO()
        with redirect_stderr(diagnostics):
            output = smoke.run([sys.executable, '-c', 'print("ready")'])
        self.assertEqual(output, 'ready\n')
        self.assertEqual(diagnostics.getvalue(), '')

    def test_timed_out_command_exposes_partial_output_without_changing_deadline_error(self):
        diagnostics = io.StringIO()
        timeout = subprocess.TimeoutExpired(['worker'], 90, output=b'worker started\n')
        with patch.object(smoke.subprocess, 'run', side_effect=timeout), redirect_stderr(diagnostics), \
                self.assertRaises(subprocess.TimeoutExpired) as failure:
            smoke.run(['worker'], timeout=90)
        self.assertIs(failure.exception, timeout)
        self.assertIn('worker started', diagnostics.getvalue())

    def test_document_smoke_uses_supported_csv_and_the_supplied_worker_resources(self):
        import csv
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory)
            env = {'PATH': '/fixture/bin'}

            def inspect(args, **options):
                sample = Path(args[2])
                self.assertEqual(sample.suffix, '.csv')
                self.assertEqual(sample.parent, scratch)
                with sample.open(newline='') as stream:
                    self.assertEqual(list(csv.reader(stream)),
                                     [['title', 'description'], ['Ubuntu package smoke', 'Offline conversion.']])
                self.assertEqual(args[:2], ['/resources/node', '/repo/scripts/document-worker-smoke.mjs'])
                self.assertEqual(args[3], '/resources/document-processing/v1')
                self.assertEqual(options, {'env': env, 'cwd': scratch, 'timeout': 90})
                return 'completed'

            with patch.object(smoke, 'run', side_effect=inspect) as run:
                smoke.check_document_worker(Path('/resources/node'), Path('/repo'),
                                            Path('/resources/document-processing/v1'), env, scratch)
            run.assert_called_once()

    def test_resource_integrity_and_path_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'resources'
            root.mkdir()
            path = root / 'model'
            path.write_bytes(b'model')
            entry = dict(path='model', size=5, sha256=hashlib.sha256(b'model').hexdigest())
            self.assertEqual(smoke.checked_file(root, entry), path)
            path.write_bytes(b'other')
            with self.assertRaisesRegex(ValueError, 'Hash mismatch'):
                smoke.checked_file(root, entry)
            path.write_bytes(b'x')
            with self.assertRaisesRegex(ValueError, 'Size mismatch'):
                smoke.checked_file(root, entry)
            outside = root.parent / 'outside'
            outside.write_bytes(b'model')
            with self.assertRaisesRegex(ValueError, 'Invalid manifest'):
                smoke.checked_file(root, dict(entry, path='../outside'))
            path.unlink()
            path.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, 'Invalid manifest'):
                smoke.checked_file(root, entry)

    def test_wrong_elf_target_fails_before_external_command(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'worker'
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            header[18:20] = (183).to_bytes(2, 'little')
            path.write_bytes(header)
            with self.assertRaisesRegex(ValueError, 'Not an x86-64'):
                smoke.check_elf(path)

    def test_renamed_native_libraries_load_in_dependency_order(self):
        document = {'files': {'onnxRuntime': {'path': 'native/onnxruntime.so'},
                              'pdfium': {'path': 'native/pdfium.so'}}}
        speech = {'files': {'sherpaOnnx': {'path': 'native/sherpa-onnx-c-api.so'},
                            'adapter': {'path': 'native/myagents-speech-adapter.so'}}}
        calls = []

        def load(path, mode=None):
            if path.endswith('/sherpa-onnx-c-api.so'):
                self.assertIn(('/document/native/onnxruntime.so', smoke.ctypes.RTLD_GLOBAL), calls)
            if path.endswith('/myagents-speech-adapter.so'):
                self.assertIn(('/speech/native/sherpa-onnx-c-api.so', smoke.ctypes.RTLD_GLOBAL), calls)
            calls.append((path, mode))
            return MagicMock()

        with patch.object(smoke.ctypes, 'CDLL', side_effect=load), patch.object(
                smoke.subprocess, 'run', side_effect=AssertionError('bare ldd cannot resolve renamed SONAMEs')):
            libraries = smoke.load_native_libraries(Path('/document'), document, Path('/speech'), speech)
        self.assertEqual(len(libraries), 4)
        self.assertEqual(len(calls), 4)


if __name__ == '__main__':
    unittest.main()
