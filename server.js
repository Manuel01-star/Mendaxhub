const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const LISTEN_HOST = "0.0.0.0";
const BACKEND_HOST = "127.0.0.1";
const PUBLIC_PORT = Number.parseInt(process.env.PORT || "3000", 10);
const BACKEND_PORT = Number.parseInt(
    process.env.INTERNAL_APP_PORT || (PUBLIC_PORT === 3000 ? "3001" : "3000"),
    10
);
const APP_PATH = path.join(__dirname, "app.py");

let backendProcess = null;
let backendReady = false;
let startupError = null;
let shuttingDown = false;
let publicServer = null;

function pythonCandidates() {
    return [
        process.env.PYTHON_BIN,
        path.join(__dirname, ".venv", "Scripts", "python.exe"),
        path.join(__dirname, "venv", "Scripts", "python.exe"),
        path.join(__dirname, ".venv", "bin", "python"),
        path.join(__dirname, "venv", "bin", "python"),
        "python3",
        "python",
        "py",
    ].filter(Boolean);
}

function commandAvailable(command) {
    if (command.includes(path.sep)) {
        return fs.existsSync(command);
    }

    const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
    return !probe.error && probe.status === 0;
}

function resolvePythonCommand() {
    for (const command of pythonCandidates()) {
        if (commandAvailable(command)) {
            return command;
        }
    }
    return null;
}

function startBackend() {
    const pythonCommand = resolvePythonCommand();
    if (!pythonCommand) {
        startupError = new Error(
            "Python 3 was not found. Set PYTHON_BIN or create a local virtual environment before starting server.js."
        );
        return;
    }

    const childEnv = {
        ...process.env,
        PORT: String(BACKEND_PORT),
    };

    backendProcess = spawn(pythonCommand, [APP_PATH], {
        cwd: __dirname,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
    });

    backendProcess.stdout.on("data", (chunk) => {
        process.stdout.write(`[python] ${chunk}`);
    });

    backendProcess.stderr.on("data", (chunk) => {
        process.stderr.write(`[python] ${chunk}`);
    });

    backendProcess.on("error", (error) => {
        startupError = error;
    });

    backendProcess.on("exit", (code, signal) => {
        backendReady = false;
        if (shuttingDown) {
            return;
        }

        const reason = signal ? `signal ${signal}` : `code ${code}`;
        startupError = new Error(`Python backend exited unexpectedly with ${reason}.`);
        console.error(startupError.message);

        if (publicServer) {
            publicServer.close(() => process.exit(code || 1));
        } else {
            process.exit(code || 1);
        }
    });
}

function isBackendReachable() {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: BACKEND_HOST, port: BACKEND_PORT });
        let settled = false;

        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            socket.destroy();
            resolve(value);
        };

        socket.setTimeout(600);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

async function waitForBackend(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (startupError) {
            throw startupError;
        }

        if (await isBackendReachable()) {
            backendReady = true;
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Python backend did not start on http://${BACKEND_HOST}:${BACKEND_PORT} in time.`);
}

function proxyRequest(request, response) {
    const proxy = http.request(
        {
            hostname: BACKEND_HOST,
            port: BACKEND_PORT,
            method: request.method,
            path: request.url,
            headers: {
                ...request.headers,
                host: `${BACKEND_HOST}:${BACKEND_PORT}`,
            },
        },
        (proxyResponse) => {
            response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
            proxyResponse.pipe(response);
        }
    );

    proxy.on("error", (error) => {
        if (response.headersSent) {
            response.destroy(error);
            return;
        }

        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`Backend request failed: ${error.message}`);
    });

    request.pipe(proxy);
}

function startProxy() {
    publicServer = http.createServer((request, response) => {
        if (!backendReady) {
            response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("The application is still starting. Refresh in a moment.");
            return;
        }

        proxyRequest(request, response);
    });

    publicServer.listen(PUBLIC_PORT, LISTEN_HOST, () => {
        console.log(`server.js is live on http://localhost:${PUBLIC_PORT}`);
        console.log(`Proxying requests to Flask on http://${BACKEND_HOST}:${BACKEND_PORT}`);
    });
}

function stopBackend() {
    if (!backendProcess) {
        return;
    }

    try {
        backendProcess.kill();
    } catch (error) {
        console.error(`Unable to stop Python backend cleanly: ${error.message}`);
    }
}

function shutdown(exitCode = 0) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;

    if (publicServer) {
        publicServer.close(() => {
            stopBackend();
            process.exit(exitCode);
        });
        setTimeout(() => {
            stopBackend();
            process.exit(exitCode);
        }, 5000).unref();
        return;
    }

    stopBackend();
    process.exit(exitCode);
}

async function main() {
    startBackend();
    await waitForBackend();
    startProxy();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((error) => {
    console.error(error.message);
    shutdown(1);
});
