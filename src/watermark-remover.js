import {
    detectVideoWatermark,
    inspectGeminiVideoFile,
    removeVideoWatermark,
    DEFAULT_ALPHA_GAIN,
    DEFAULT_SAMPLE_COUNT,
    DEFAULT_VIDEO_BITRATE,
    VIDEO_DENOISE_BACKENDS
} from './video/videoExport.js';
import { resolveAllenkFdncnnRuntimeProfile } from './video/videoDenoiseRuntimePolicy.js';
import { createAllenkFdncnnOnnxRuntime } from './core/allenkFdncnnOnnxRuntime.js';
import { getDebugFileKind } from './shared/debugFileHandoff.js';

const ALLENK_FDNCNN_WASM_PATHS = Object.freeze({
    mjs: './onnxruntime/ort-wasm-simd-threaded.js',
    wasm: './onnxruntime/ort-wasm-simd-threaded.wasm'
});
const ALLENK_FDNCNN_WEBGPU_WASM_PATHS = Object.freeze({
    mjs: './onnxruntime/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: './onnxruntime/ort-wasm-simd-threaded.asyncify.wasm'
});

const $ = (id) => document.getElementById(id);

const els = {
    dropzone: $('dropzone'),
    fileInput: $('fileInput'),
    videoPlayer: $('videoPlayer'),
    progressFill: $('progressFill'),
    progressText: $('progressText'),
    statusBox: $('statusBox'),
    fileInfo: $('fileInfo'),
    detectInfo: $('detectInfo'),
    processBtn: $('processBtn'),
    detectBtn: $('detectBtn'),
    downloadBtn: $('downloadBtn'),
    resetBtn: $('resetBtn')
};

const state = {
    file: null,
    originalUrl: null,
    processedBlob: null,
    processedUrl: null,
    metadata: null,
    detection: null,
    running: false,
    jobId: 0
};

let allenkFdncnnRuntime = null;

function setStatus(message, tone = 'info') {
    els.statusBox.textContent = message || '';
    els.statusBox.className = 'status-box';
    if (tone) els.statusBox.classList.add(tone);
}

function setProgress(pct, label) {
    const safe = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct * 100))) : 0;
    els.progressFill.style.width = `${safe}%`;
    els.progressText.textContent = label || `${safe}%`;
}

function updateButtons() {
    const hasFile = Boolean(state.file);
    const hasProcessed = Boolean(state.processedUrl);
    const busy = state.running;
    els.processBtn.disabled = !hasFile || busy || hasProcessed;
    els.detectBtn.disabled = !hasFile || busy;
    els.downloadBtn.disabled = !hasProcessed || busy;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return 'Unknown';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBitrate(value) {
    if (!Number.isFinite(value)) return 'Unknown';
    return `${(value / 1000000).toFixed(1)} Mbps`;
}

function yieldToMainThread() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => setTimeout(resolve, 0));
        } else {
            setTimeout(resolve, 0);
        }
    });
}

function cleanupUrls() {
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.processedUrl) URL.revokeObjectURL(state.processedUrl);
    state.originalUrl = null;
    state.processedUrl = null;
}

function renderFileInfo(meta) {
    if (!meta) {
        els.fileInfo.innerHTML = `<div class="row"><span class="label">No file loaded</span><span class="value"></span></div>`;
        return;
    }
    els.fileInfo.innerHTML = `
        <div class="row"><span class="label">Resolution</span><span class="value">${meta.width} x ${meta.height}</span></div>
        <div class="row"><span class="label">Duration</span><span class="value">${formatDuration(meta.duration)}</span></div>
        <div class="row"><span class="label">Frame rate</span><span class="value">${meta.frameRate.toFixed(2)} fps</span></div>
        <div class="row"><span class="label">Bitrate</span><span class="value">${formatBitrate(meta.averageBitrate)}</span></div>
        <div class="row"><span class="label">Frames (est.)</span><span class="value">${meta.frameCountEstimate || '?'}</span></div>
    `;
}

function renderDetection(detection) {
    if (!detection) {
        els.detectInfo.innerHTML = `<span class="label">Detection</span><span class="value">Waiting for detection...</span>`;
        return;
    }
    const pos = detection.position || {};
    const kind = detection.detector === 'generic-video' ? 'Generic (any watermark)' : detection.watermarkKind || 'Detected';
    const conf = Number.isFinite(detection.confidence) ? (detection.confidence * 100).toFixed(1) + '%' : 'N/A';
    els.detectInfo.innerHTML = `
        <span class="label">Type</span><span class="value">${kind}</span>
        <span class="label">Position</span><span class="value">x:${pos.x || '?'} y:${pos.y || '?'} (${pos.width||'?'}x${pos.height||'?'})</span>
        <span class="label">Confidence</span><span class="value">${conf}</span>
        <span class="label">Status</span><span class="value">${detection.isConfident ? 'Ready for removal' : 'Low confidence but can try'}</span>
    `;
}

async function loadAllenkFdncnnRuntime() {
    if (allenkFdncnnRuntime) return allenkFdncnnRuntime;
    setStatus('Loading AI model (first load may take a moment)...', 'info');
    try {
        const profile = resolveAllenkFdncnnRuntimeProfile();
        const response = await fetch(profile.modelUrl);
        if (!response.ok) throw new Error(`AI model unavailable: ${response.status}`);
        const modelBytes = new Uint8Array(await response.arrayBuffer());
        let ort;
        try {
            ort = await import('onnxruntime-web/webgpu');
        } catch {
            ort = await import('onnxruntime-web/wasm');
        }
        allenkFdncnnRuntime = await createAllenkFdncnnOnnxRuntime({
            ort,
            modelBytes,
            executionProvider: ort.env?.webgpu ? 'webgpu' : 'wasm',
            wasmPaths: ort.env?.webgpu ? ALLENK_FDNCNN_WEBGPU_WASM_PATHS : ALLENK_FDNCNN_WASM_PATHS,
            inputName: 'fdncnn_input',
            outputName: 'fdncnn_output',
            inputShape: profile.inputShape,
            outputShape: profile.outputShape
        });
        setStatus('AI model ready for high-quality cleanup', 'ok');
        return allenkFdncnnRuntime;
    } catch (err) {
        console.warn('AI model loading failed, will proceed without:', err);
        setStatus('AI model unavailable, using standard cleanup', 'warn');
        return null;
    }
}

async function detect(file) {
    const jobId = ++state.jobId;
    state.running = true;
    updateButtons();
    setProgress(5, 'Detecting');
    setStatus('Analyzing video frames to locate watermark...', 'info');

    try {
        await yieldToMainThread();
        const result = await detectVideoWatermark(file, {
            mode: 'generic',
            sampleCount: DEFAULT_SAMPLE_COUNT,
            yieldToMainThread,
            onProgress: ({ progress, step, sampledFrames, sampleCount }) => {
                if (jobId !== state.jobId) return;
                if (step === 'sample') {
                    const msg = sampleCount > 0
                        ? `Scanning frames: ${sampledFrames}/${sampleCount}`
                        : 'Scanning frames...';
                    setProgress(5 + progress * 85, msg);
                } else if (step === 'score') {
                    setProgress(75, 'Matching watermark patterns...');
                }
            }
        });
        if (jobId !== state.jobId) return null;

        state.metadata = result.metadata;
        state.detection = result.detection;
        renderFileInfo(result.metadata);
        renderDetection(result.detection);

        if (result.detection.isConfident) {
            setProgress(100, 'Watermark found!');
            setStatus(`Watermark detected (confidence: ${(result.detection.confidence * 100).toFixed(0)}%)`, 'ok');
        } else {
            setProgress(100, 'Low confidence detection');
            setStatus('Watermark may be faint — can still try removal', 'warn');
        }
        return result.detection;
    } catch (err) {
        console.error('Detection failed:', err);
        setStatus(`Detection error: ${err.message}`, 'err');
        setProgress(0, 'Detection failed');
        return null;
    } finally {
        state.running = false;
        updateButtons();
    }
}

async function runRemoval() {
    if (!state.file || state.running) return;
    const jobId = ++state.jobId;
    state.running = true;
    updateButtons();
    setProgress(0, 'Starting');
    setStatus('Preparing watermark removal...', 'info');

    try {
        await yieldToMainThread();
        if (!state.detection) {
            await detect(state.file);
            await yieldToMainThread();
        }
        if (jobId !== state.jobId) return;
        if (!state.detection || !state.detection.position) {
            throw new Error('Could not detect any watermark in this video');
        }

        const runtime = await loadAllenkFdncnnRuntime();
        await yieldToMainThread();
        if (jobId !== state.jobId) return;

        const profile = runtime ? resolveAllenkFdncnnRuntimeProfile(state.detection.position) : null;

        setStatus('Removing watermark frame-by-frame...', 'info');
        console.info('[Watermark Remover] Starting export...');

        const result = await removeVideoWatermark(state.file, {
            mode: 'generic',
            detection: { metadata: state.metadata, detection: state.detection },
            alphaGain: DEFAULT_ALPHA_GAIN,
            adaptiveAlpha: false,
            denoiseBackend: runtime
                ? VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE
                : VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH,
            videoBitrate: DEFAULT_VIDEO_BITRATE,
            highQualityCleanup: true,
            allowLowConfidence: true,
            allenkFdncnnRuntime: runtime,
            allenkFdncnnSigma: 75,
            allenkFdncnnPadding: profile?.padding ?? 64,
            allenkFdncnnTemporalReuse: null,
            yieldToMainThread,
            onProgress: ({ phase, progress, processedFrames, metadata, detection }) => {
                if (jobId !== state.jobId) return;
                if (metadata) {
                    state.metadata = metadata;
                    renderFileInfo(metadata);
                }
                if (detection) {
                    state.detection = detection;
                    renderDetection(detection);
                }
                if (phase === 'export') {
                    const pct = 12 + progress * 88;
                    const frames = Number.isFinite(processedFrames) ? `${processedFrames} frames` : 'Processing';
                    setProgress(pct, `${frames}`);
                    setStatus(`Removing watermark: ${frames}`, 'info');
                }
            }
        });

        if (jobId !== state.jobId) return;

        if (state.processedUrl) URL.revokeObjectURL(state.processedUrl);
        state.processedBlob = result.blob;
        state.processedUrl = URL.createObjectURL(result.blob);

        const audioNote = result.audioCopied
            ? `Audio preserved (${result.audioCodec || 'unknown'})`
            : `Audio: ${result.audioSkipReason || 'not copied'}`;
        setProgress(100, 'Done');
        setStatus(`Watermark removed! Processed ${result.processedFrames} frames. ${audioNote}`, 'ok');
        console.info('[Watermark Remover] Complete:', {
            frames: result.processedFrames,
            audio: result.audioCopied,
            runtime
        });
        updateButtons();
    } catch (err) {
        console.error('[Watermark Remover] Failed:', err);
        setProgress(0, 'Failed');
        setStatus(`Error: ${err.message}`, 'err');
        state.running = false;
        updateButtons();
    }
}

function download() {
    if (!state.processedUrl) return;
    const a = document.createElement('a');
    a.href = state.processedUrl;
    const name = state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'video';
    a.download = `${name}_no_watermark.mp4`;
    a.click();
}

async function handleFile(file) {
    cleanupUrls();
    state.file = file;
    state.metadata = null;
    state.detection = null;
    state.processedBlob = null;
    state.processedUrl = null;
    state.jobId++;

    const url = URL.createObjectURL(file);
    state.originalUrl = url;
    els.videoPlayer.src = url;
    els.videoPlayer.hidden = false;
    els.dropzone.style.display = 'none';
    renderFileInfo(null);
    renderDetection(null);
    setProgress(0, 'Reading...');
    setStatus('Reading video metadata...', 'info');
    updateButtons();

    try {
        const meta = await inspectGeminiVideoFile(file);
        state.metadata = meta;
        renderFileInfo(meta);
        setStatus('Video loaded. Click "Remove Watermark" to start.', 'info');
        setProgress(0, 'Ready');
    } catch (err) {
        console.error('Metadata read failed:', err);
        setStatus(`Could not read video: ${err.message}`, 'err');
    }
    updateButtons();
    await detect(file);
}

function resetUI() {
    state.jobId++;
    cleanupUrls();
    state.file = null;
    state.metadata = null;
    state.detection = null;
    state.processedBlob = null;
    state.processedUrl = null;
    state.running = false;
    els.fileInput.value = '';
    els.videoPlayer.src = '';
    els.videoPlayer.hidden = true;
    els.dropzone.style.display = '';
    renderFileInfo(null);
    renderDetection(null);
    setProgress(0, 'Ready');
    setStatus('Select a video file to begin', 'info');
    updateButtons();
}

function setup() {
    els.dropzone.addEventListener('click', () => els.fileInput.click());
    els.dropzone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropzone.classList.add('dragging'); });
    els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('dragging'));
    els.dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        els.dropzone.classList.remove('dragging');
        const file = e.dataTransfer?.files?.[0];
        if (file && file.type.startsWith('video/')) handleFile(file);
    });
    els.fileInput.addEventListener('change', () => {
        const file = els.fileInput.files?.[0];
        if (file) handleFile(file);
    });
    els.processBtn.addEventListener('click', runRemoval);
    els.detectBtn.addEventListener('click', () => { if (state.file) detect(state.file); });
    els.downloadBtn.addEventListener('click', download);
    els.resetBtn.addEventListener('click', resetUI);
    window.addEventListener('beforeunload', cleanupUrls);
    updateButtons();
}

if ('VideoDecoder' in window && 'VideoEncoder' in window) {
    setup();
} else {
    setStatus('Your browser does not support WebCodecs. Please use Chrome, Edge, or another Chromium browser.', 'err');
}
