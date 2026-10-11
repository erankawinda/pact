import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectPhoto, MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, MAX_SOURCE_EDGE, MAX_PHOTO_BYTES} from '../src/photoProcessing';

// Real synthetic 3 x 2 rasters generated with Pillow, never household photos.
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDoDoWkTz3Ly6VYyMLiVAXt0JCq7BR06AAAegFFFFfe5X/uNH/BH8kfE5j/AL5V/wAUvzZ//9k=','base64');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAGUlEQVR4nGP4z8DAAMZMDP8Z/jP+Z/jPAABA7Ab92OkVSwAAAABJRU5ErkJggg==','base64');
const webp=Buffer.from('UklGRmgAAABXRUJQVlA4IFwAAACwAwCdASoDAAIAAUAmJagCdLoB+AH4gUoCqAP4BlAH6AAt2ZpmAAD+m7Pj/WW1boYWXX5+jgc+sAmPn/6jT4RcbKe7R78IuNlP/Tb/5jP1W6p5xhvvqt1T39SAAA==','base64');
const webpLossless=Buffer.from('UklGRjAAAABXRUJQVlA4TCQAAAAvAkAAAC8gEEjaH3qN+RcQFPk/2vwHH0QCg0CADPHiSET/IxY=','base64');
const webpExtended=Buffer.from('UklGRooAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAgP//////AFZQOCBcAAAAkAMAnQEqAwACAAFAJiWoAnS6AfgB+IFKAqgD+AZQB+gALdmZkAD+m7Pj/WW1boYWXX5+jgc+sAmPn/6vT4RcbKe7R78IuNlP/Tb/5uPzOYuUd0o/M5i5f49AAAA=','base64');

const be32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
function crc32(bytes:Uint8Array){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function pngChunk(type:string,payload:Uint8Array){const body=Buffer.concat([Buffer.from(type),payload]);return Buffer.concat([be32(payload.length),body,be32(crc32(body))]);}
function pngDimensions(width:number,height:number){const out=Buffer.from(png);out.writeUInt32BE(width,16);out.writeUInt32BE(height,20);out.writeUInt32BE(crc32(out.subarray(12,29)),29);return out;}
function box(type:string,payload:Uint8Array){return Buffer.concat([be32(payload.length+8),Buffer.from(type),payload]);}
function heif(width:number,height:number){return Buffer.concat([
 box('ftyp',Buffer.concat([Buffer.from('heic'),be32(0),Buffer.from('mif1heic')])),
 box('meta',Buffer.concat([be32(0),box('iprp',box('ipco',box('ispe',Buffer.concat([be32(0),be32(width),be32(height)]))))]))
]);}

test('photo headers identify supported rasters independently of filename or claimed MIME',()=>{
 for(const [bytes,format] of [[jpeg,'jpeg'],[png,'png'],[webp,'webp'],[webpLossless,'webp'],[webpExtended,'webp']] as const){
  assert.deepEqual(inspectPhoto(bytes),{format,width:3,height:2});
  const padded=Buffer.concat([Buffer.alloc(7),bytes,Buffer.alloc(9)]);
  assert.deepEqual(inspectPhoto(padded.subarray(7,7+bytes.length)),{format,width:3,height:2},'respect the byte view offset and length');
 }
 assert.deepEqual(inspectPhoto(heif(4032,3024)),{format:'heif',width:4032,height:3024});
});

test('phone photo limits constrain source bytes, dimensions and decoded pixels before processing',()=>{
 assert.equal(MAX_SOURCE_BYTES,25*1024*1024);assert.equal(MAX_SOURCE_PIXELS,64_000_000);assert.equal(MAX_SOURCE_EDGE,12000);assert.equal(MAX_PHOTO_BYTES,262144);
 assert.deepEqual(inspectPhoto(pngDimensions(8000,8000)),{format:'png',width:8000,height:8000});
 assert.deepEqual(inspectPhoto(pngDimensions(12000,1)),{format:'png',width:12000,height:1});
 for(const [w,h] of [[0,1],[1,0],[12001,1],[1,12001],[8001,8000],[0xffffffff,0xffffffff]])assert.throws(()=>inspectPhoto(pngDimensions(w,h)),`${w} x ${h} must be rejected`);
 const huge=Buffer.alloc(MAX_SOURCE_BYTES+1);png.copy(huge);
 assert.throws(()=>inspectPhoto(huge),'oversized source cannot bypass the processing limit');
});

test('malformed, truncated and non-image inputs cannot be accepted as profile photos',()=>{
 for(const bytes of [Buffer.alloc(0),Buffer.from('not a photo'),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),Buffer.from('<!doctype html><h1>photo.jpg</h1>'),Buffer.from('GIF89a'),png.subarray(0,24),jpeg.subarray(0,10),webp.subarray(0,20)])assert.throws(()=>inspectPhoto(bytes));
 const badPng=Buffer.from(png);badPng[0]=0;assert.throws(()=>inspectPhoto(badPng));
 const badRiff=Buffer.from(webp);badRiff.writeUInt32LE(0x7fffffff,4);assert.throws(()=>inspectPhoto(badRiff),'declared RIFF length cannot exceed source');
 const noSize=Buffer.concat([box('ftyp',Buffer.concat([Buffer.from('heic'),be32(0),Buffer.from('mif1heic')])),box('free',Buffer.from('ispe'))]);
 assert.throws(()=>inspectPhoto(noSize),'a string containing ispe is not a valid image property');
 const truncatedBox=Buffer.from(heif(4032,3024));truncatedBox.writeUInt32BE(0x7fffffff,0);assert.throws(()=>inspectPhoto(truncatedBox));
});

test('animated containers and unbounded image boxes are rejected instead of decoding expensive inputs',()=>{
 const animatedPng=Buffer.concat([png.subarray(0,33),pngChunk('acTL',Buffer.concat([be32(2),be32(0)])),png.subarray(33)]);
 assert.throws(()=>inspectPhoto(animatedPng),'animated PNG must be rejected');
 const animatedWebp=Buffer.from(webpExtended);const vp8x=animatedWebp.indexOf(Buffer.from('VP8X'));assert.ok(vp8x>=0);animatedWebp[vp8x+8]|=2;
 assert.throws(()=>inspectPhoto(animatedWebp),'animated WebP must be rejected');
 for(const [width,height] of [[0,1],[12001,1],[8001,8000]])assert.throws(()=>inspectPhoto(heif(width,height)));
 const badChild=Buffer.from(heif(3,2));const ispe=badChild.indexOf(Buffer.from('ispe'));badChild.writeUInt32BE(0x7fffffff,ispe-4);
 assert.throws(()=>inspectPhoto(badChild),'nested box cannot escape its enclosing bounds');
});
