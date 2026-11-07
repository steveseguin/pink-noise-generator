const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Run the page's real handlers with deterministic audio and animation schedulers.
function createPage() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const frames = new Map();
    const nodes = [];
    let nextFrame = 0;
    let draws = 0;
    let click;
    const button = { textContent: 'Play Pink Noise', addEventListener(_, handler) { click = handler; } };
    const canvasContext = new Proxy({}, {
        get(_, key) { return key === 'stroke' ? () => { draws++; } : () => {}; }
    });
    const analyser = {
        frequencyBinCount: 1024,
        connected: false,
        connect() { this.connected = true; },
        disconnect() { this.connected = false; },
        getByteFrequencyData(data) { data.fill(0); }
    };
    class AudioContext {
        destination = {};
        createAnalyser() { return analyser; }
        resume() { return Promise.resolve(); }
        createScriptProcessor() {
            const node = {
                connected: false,
                connect() { this.connected = true; },
                disconnect() { this.connected = false; }
            };
            nodes.push(node);
            return node;
        }
    }
    vm.runInNewContext(script, {
        console: { log() {} },
        window: { AudioContext },
        document: {
            addEventListener(_, handler) { handler(); },
            getElementById(id) {
                return id === 'toggleNoise' ? button : {
                    width: 640, height: 100, getContext() { return canvasContext; }
                };
            }
        },
        requestAnimationFrame(callback) {
            const id = nextFrame++;
            frames.set(id, callback);
            return id;
        },
        cancelAnimationFrame(id) { frames.delete(id); }
    });
    return {
        button, nodes, analyser,
        click() { click.call(button); },
        get pendingFrames() { return frames.size; },
        get draws() { return draws; },
        frame() {
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach(callback => callback());
        }
    };
}

test('stopping playback cancels the visualizer, including a zero-valued frame ID', () => {
    const page = createPage();
    assert.equal(page.pendingFrames, 0);
    page.click();
    assert.equal(page.button.textContent, 'Stop Pink Noise');
    assert.equal(page.pendingFrames, 1);
    assert.equal(page.nodes[0].connected, true);
    page.click();
    assert.equal(page.button.textContent, 'Play Pink Noise');
    assert.equal(page.nodes[0].connected, false);
    assert.equal(page.analyser.connected, false);
    assert.equal(page.pendingFrames, 0);
    const draws = page.draws;
    page.frame();
    assert.equal(page.draws, draws);
});

test('repeated play/stop cycles retain one visualizer loop and one audio source', () => {
    const page = createPage();
    for (let cycle = 0; cycle < 25; cycle++) {
        page.click();
        assert.equal(page.pendingFrames, 1);
        assert.equal(page.nodes.filter(node => node.connected).length, 1);
        for (let frame = 0; frame < 3; frame++) {
            const draws = page.draws;
            page.frame();
            assert.equal(page.draws, draws + 1);
            assert.equal(page.pendingFrames, 1);
        }
        page.click();
        assert.equal(page.pendingFrames, 0);
        assert.equal(page.nodes.filter(node => node.connected).length, 0);
        const draws = page.draws;
        page.frame();
        assert.equal(page.draws, draws);
    }
});

test('immediate stop and restart do not leave a second animation chain', () => {
    const page = createPage();
    page.click();
    page.click();
    page.click();
    assert.equal(page.pendingFrames, 1);
    const draws = page.draws;
    page.frame();
    assert.equal(page.draws, draws + 1);
});

test('each new audio source still fills a finite non-silent noise buffer', () => {
    const page = createPage();
    for (let cycle = 0; cycle < 3; cycle++) {
        page.click();
        const output = new Float32Array(4096);
        page.nodes.at(-1).onaudioprocess({
            outputBuffer: { getChannelData(channel) { assert.equal(channel, 0); return output; } }
        });
        assert(output.every(Number.isFinite));
        assert(output.some(value => value !== 0));
        page.click();
    }
});
