import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageKeys, imageMediaType, imageLimits, prepareImages } from '../lark-channel/images.mjs';

const jpeg = Buffer.from([255, 216, 255, 224, 0, 0]);
test('extract image resources from rich text, raw image and multilingual post, preserving order', () => {
  assert.deepEqual(imageKeys('![Image](img_v3_one)\n问题\n![Image](img_v3_two)\n![Image](img_v3_one)'), ['img_v3_one', 'img_v3_two']);
  assert.deepEqual(imageKeys('{"image_key":"img_one"}'), ['img_one']);
  assert.deepEqual(imageKeys({ zh_cn: { content: [[{ tag: 'img', image_key: 'img_two' }]] } }), ['img_two']);
  assert.deepEqual(imageKeys('文字中的 img_no 不应该下载；![Image](https://example.com/evil.png)'), []);
  assert.deepEqual(imageKeys('![Image](img_../../escape)'), []);
  assert.deepEqual(imageKeys('[Image: img_v3_new]'), ['img_v3_new']);
  assert.deepEqual(imageKeys('看看这个\n[Image: img_v3_a]\n还有 [image:img_v3_b] 和 ![Image](img_v3_a)'), ['img_v3_a', 'img_v3_b']);
  assert.deepEqual(imageKeys('[Image: https://example.com/x.png] [Image: img_../../escape]'), []);
});
test('inspect actual image bytes instead of trusting downloaded filename', () => {
  assert.equal(imageMediaType(jpeg), 'image/jpeg');
  assert.equal(imageMediaType(Buffer.from([137,80,78,71,13,10,26,10])), 'image/png');
  assert.equal(imageMediaType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageMediaType(Buffer.from('RIFF0000WEBP')), 'image/webp');
  assert.throws(() => imageMediaType(Buffer.from('<html>not an image</html>')), /格式/);
});
test('download exact message resources into private workspace files and pass bytes', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-images-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { backend: 'claude', workspace: path.join(root, 'workspace') };
  const event = { message_id: 'om_one', message_type: 'post', content: '![Image](img_one)\n请看图' };
  const calls = [];
  let stagingDir;
  const runLark = async (args, timeout, cwd) => {
    calls.push(args);
    // lark-cli refuses to write under /root, so downloads go to a private temp directory first.
    stagingDir = cwd;
    assert(cwd.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && !cwd.startsWith(config.workspace));
    if (process.platform !== 'win32') assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
    assert.equal(args[args.indexOf('--message-id') + 1], 'om_one');
    assert.equal(args[args.indexOf('--file-key') + 1], 'img_one');
    assert.equal(args[args.indexOf('--output') + 1], 'image-1');
    // Recent lark-cli versions report an absolute saved_path.
    const saved = path.join(cwd, 'image-1.jpg');
    fs.writeFileSync(saved, jpeg);
    return { saved_path: saved, size_bytes: jpeg.length };
  };
  const images = await prepareImages(event, config, runLark, root);
  assert.equal(calls.length, 1);
  assert.equal(images.length, 1);
  assert.equal(images[0].data, jpeg.toString('base64'));
  assert.equal(images[0].mediaType, 'image/jpeg');
  if (process.platform !== 'win32') assert.equal(fs.statSync(images[0].path).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(images[0].path)).mode & 0o777, 0o700);
  assert(images[0].path.startsWith(path.join(config.workspace, 'attachments') + path.sep) && images[0].path.endsWith('image-1.jpg'));
  assert.deepEqual(fs.readFileSync(images[0].path), jpeg);
  assert(!fs.existsSync(stagingDir), 'staging directory is removed');
  assert.deepEqual(await prepareImages({ ...event, message_type: 'file' }, config, runLark, root), []);
});
test('resolve omitted event image keys from the same message; missing keys are explicit failures', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-images-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { backend: 'claude', workspace: path.join(root, 'workspace') };
  let fetched = false;
  const runLark = async (args, timeout, cwd) => {
    if (args[1] === '+messages-mget') {
      fetched = true;
      assert.equal(args[args.indexOf('--message-ids') + 1], 'om_image');
      return { messages: [{ message_id: 'om_image', content: '![Image](img_real)' }] };
    }
    const saved_path = args[args.indexOf('--output') + 1] + '.jpg';
    fs.writeFileSync(path.resolve(cwd, saved_path), jpeg);
    return { saved_path };
  };
  assert.equal((await prepareImages({ message_id: 'om_image', message_type: 'image', content: '[Image]' }, config, runLark, root)).length, 1);
  assert(fetched);
  await assert.rejects(prepareImages({ message_id: 'om_image', message_type: 'image', content: '' }, config, async () => ({ messages: [] }), root), /没有取到/);
});
test('reject too many, oversized, inaccessible and misplaced images instead of silently dropping them', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-images-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { backend: 'claude', workspace: path.join(root, 'workspace') };
  const event = { message_id: 'om_limit', message_type: 'image', content: '![Image](img_one)' };
  await assert.rejects(prepareImages({ ...event, content: Array.from({ length: 5 }, (_, i) => `![Image](img_${i})`).join('\n') }, config, async () => assert.fail(), root), /4 张/);
  await assert.rejects(prepareImages(event, config, async () => { throw new Error('missing_scope'); }, root), /下载失败/);
  fs.writeFileSync(path.join(root, 'outside.jpg'), jpeg);
  await assert.rejects(prepareImages(event, config, async () => ({ saved_path: path.join(root, 'outside.jpg') }), root), /下载结果异常/);
  await assert.rejects(prepareImages(event, config, async (args, timeout, cwd) => {
    const saved_path = args[args.indexOf('--output') + 1] + '.jpg';
    fs.writeFileSync(path.resolve(cwd, saved_path), Buffer.alloc(imageLimits.bytes + 1));
    return { saved_path };
  }, root), /图片过大/);
});
test('macOS-style symlinked paths are accepted, but a downloaded symlink to another file is not', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-images-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The workspace is reached through a symlink, like /var -> /private/var on macOS.
  fs.mkdirSync(path.join(root, 'real-workspace'));
  fs.symlinkSync(path.join(root, 'real-workspace'), path.join(root, 'workspace'));
  const config = { workspace: path.join(root, 'workspace') };
  const event = { message_id: 'om_mac', message_type: 'image', content: '[Image: img_v3_mac]' };
  // lark-cli reports the saved file through a symlinked alias of the staging directory.
  const images = await prepareImages(event, config, async (args, timeout, cwd) => {
    const alias = path.join(root, 'staging-alias');
    fs.rmSync(alias, { force: true });
    fs.symlinkSync(cwd, alias);
    fs.writeFileSync(path.join(cwd, 'image-1.jpg'), jpeg);
    return { saved_path: path.join(alias, 'image-1.jpg') };
  });
  assert.equal(images.length, 1);
  assert(images[0].path.startsWith(path.join(root, 'real-workspace', 'attachments') + path.sep));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'not an image');
  await assert.rejects(prepareImages({ ...event, message_id: 'om_link' }, config, async (args, timeout, cwd) => {
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(cwd, 'image-1.jpg'));
    return { saved_path: path.join(cwd, 'image-1.jpg') };
  }), /下载结果异常/);
});
