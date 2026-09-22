import assert from 'node:assert/strict';
import { validateSkillFrontmatter, validateSkillReferences, SkillValidationError, skillUtf8 } from '../dist/services/skills/skillValidation.js';
const source = (header, body='Instructions.') => Buffer.from(`---\n${header}\n---\n${body}\n`);
const base = 'name: sample\ndescription: Valid sample';
let checks=0;
function reject(bytes, name='sample') {
  assert.throws(()=>validateSkillFrontmatter(bytes,name),e=>e instanceof SkillValidationError && !e.message.includes('PRIVATE'));
  checks++;
}
for(const name of ['sample','écriture','中文','a-2','a'.repeat(64)]) {
  const fm=validateSkillFrontmatter(source(`name: ${name}\ndescription: Use this skill`),name);
  assert.equal(fm.name,name); checks++;
}
const authored=source(base+'\nlicense: MIT\ncompatibility: Requires a local account\nallowed-tools: Bash(git:*)\nmetadata:\n  version: "1"\n  reference_gate: "true"\nfuture:\n  enabled: true\n  count: 4\n  items: [null, 2.5, text]\n  date: 2026-09-22');
const fm=validateSkillFrontmatter(authored,'sample');
assert.deepEqual(fm,{name:'sample',description:'Valid sample',license:'MIT',compatibility:'Requires a local account','allowed-tools':'Bash(git:*)',metadata:{version:'1',reference_gate:'true'},future:{enabled:true,count:4,items:[null,2.5,'text'],date:'2026-09-22'}});checks++;
const bom=Buffer.concat([Buffer.from([239,187,191]),Buffer.from(authored.toString().replace(/\n/g,'\r\n'))]);
assert.deepEqual(validateSkillFrontmatter(bom,'sample'),fm);
assert.equal(Buffer.from(skillUtf8(bom)).equals(bom),true,'resource text must retain BOM and CRLF');checks++;
for(const name of ['','Upper','a_b','-sample','sample-','sample--a','a'.repeat(65),'two words','sample/other']) reject(source(`name: "${name}"\ndescription: x`),name);
reject(source(base),'different-folder');
for(const desc of ['','   ','x'.repeat(1025)])reject(source('name: sample\ndescription: '+JSON.stringify(desc)));
for(const suffix of [
  '\nname: other','\nmetadata: 3','\nmetadata: [x]','\nmetadata: null',
  '\nmetadata:\n  version: 1','\nmetadata:\n  enabled: true',
  '\nmetadata:\n  nested: {a: b}', '\ncompatibility: ""','\ncompatibility: '+JSON.stringify('x'.repeat(501)),
  '\nlicense: 2','\nallowed-tools: [Bash]', '\nx: .nan','\nx: .inf','\nx: 9007199254740993',
  '\nx: &ref {a: 1}\ny: *ref','\nx: !!js/function PRIVATE','\nx:\n  1: value',
])reject(source(base+suffix));
for(const bytes of [Buffer.from('No frontmatter'),Buffer.from(' \n'+authored),Buffer.from('---\nname: sample\ndescription: x'),Buffer.from([255,0,128]),source('[invalid yaml'),source('name: sample')])reject(bytes);
reject(source(base+'\nbig: '+ 'x'.repeat(70*1024)));
reject(source(base+'\nx: '+ '['.repeat(20)+'0'+']'.repeat(20)));
const proto=validateSkillFrontmatter(source(base+'\n__proto__:\n  marker: PRIVATE\nconstructor: inert-data'),'sample');
assert.equal(Object.hasOwn(proto,'__proto__'),true);assert.equal({}.marker,undefined);checks++;

const files = body=>[
 {path:'SKILL.md',bytes:source(base,body)},
 {path:'references/one.md',bytes:Buffer.from('[back](../SKILL.md#invariants) [sibling](two.md)')},
 {path:'references/two.md',bytes:Buffer.from('Details')},
 {path:'assets/éclairage #1.bin',bytes:Buffer.from([0,255])},
];
validateSkillReferences(files('[ref](references/one.md) ![asset](assets/%C3%A9clairage%20%231.bin) [web](https://example.invalid/not-fetched) [nested](skill://other/skill/SKILL.md)'));checks++;
for(const target of ['../private','/etc/passwd','C:/private','references/missing.md','%2e%2e/private','references/%2e%2e/%2e%2e/private','%00','%zz','file:///private','javascript:alert(1)','data:text/plain,private','//example.invalid/path']) {
 assert.throws(()=>validateSkillReferences(files(`[bad](${target})`)),SkillValidationError,target); checks++;
}
const refs=files('```bash\ncat ../operator-only-prerequisite\n```\nInline `../../not-an-access-grant`');
validateSkillReferences(refs);checks++;
assert.throws(()=>validateSkillReferences([{path:'SKILL.md',bytes:Buffer.alloc(1024*1024+1,65)}]),SkillValidationError);checks++;
console.log(`PASS: ${checks} Agent Skills frontmatter, verbatim JSON, raw encoding and reference validation checks`);
