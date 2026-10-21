/** The S3 signer (M66, ADR 0060) against AWS's published Signature Version 4 examples. */
import { encodeRfc3986, signV4 } from '../s3.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};

const creds = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  amzDate: '20130524T000000Z',
  host: 'examplebucket.s3.amazonaws.com',
};
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// "Example: GET Object" in the S3 API reference, Signature Version 4.
const get = signV4({ ...creds, method: 'GET', path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: EMPTY });
ok("GET OBJECT MATCHES AWS'S EXAMPLE", get.authorization!.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'));
ok('…with the headers it signed', get.authorization!.includes('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date'));
ok('…and the credential scope', get.authorization!.includes('Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request'));

// "Example: GET Bucket (List Objects)".
const list = signV4({ ...creds, method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: EMPTY });
ok("LIST OBJECTS MATCHES AWS'S EXAMPLE", list.authorization!.endsWith('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'));

ok('RFC 3986 encoding of the characters encodeURIComponent leaves', encodeRfc3986("a b!'()*/~") === 'a%20b%21%27%28%29%2A%2F~');

if (fails) process.exit(1);
