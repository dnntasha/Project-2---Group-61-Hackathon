import { spawn } from 'child_process';

export function executePython(code, stdin = '') {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', ['-c', code]);

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('error', (error) => {
      reject(error);
    });

    pythonProcess.on('close', (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode,
      });
    });

    if (stdin) {
      pythonProcess.stdin.write(stdin);
    }

    pythonProcess.stdin.end();
  });
}
