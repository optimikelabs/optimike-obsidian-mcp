import assert from 'node:assert/strict';
process.env.OBSIDIAN_API_KEY='test-no-network';process.env.OBSIDIAN_RUNTIME_MODE='hybrid';
const {processObsidianReadNote,ObsidianReadNoteInputSchema}=await import('../dist/mcp-server/tools/obsidianReadNoteTool/logic.js');
const content='---\ncustom: élysia\n---\n## Lecture\n\nUn texte avec accents ✅\n';
const stat={ctime:1700000000000,mtime:1700000000000,size:Buffer.byteLength(content)};
const context={requestId:'optional-stats-test',timestamp:new Date().toISOString(),operation:'test'};
for(const format of ['markdown',undefined]){
 const input=ObsidianReadNoteInputSchema.parse({filePath:'Test.md',format});
 const api={getFileContent:async()=>({content,get stat(){throw new Error('Unexpected statistics access');}})};
 const out=await processObsidianReadNote(input,context,api);assert.equal(out.content,content);assert.equal(out.stats,undefined);
}
const api={getFileContent:async()=>({content,stat,path:'Test.md',frontmatter:{custom:'élysia'},tags:[]})};
const cache={isReady:()=>true,findMatchingPath:path=>path,getEntry:async()=>({content,...stat})};
for(const service of [api,undefined]){
 let expectedTokens;
 for(const input of [{format:'markdown'},{format:'markdown',includeStat:true},{format:'json'}]){
  const out=await processObsidianReadNote(ObsidianReadNoteInputSchema.parse({filePath:'Test.md',...input}),context,service,cache);
  assert.equal(typeof out.content==='string'?out.content:out.content.content,content);
  if(input.includeStat||input.format==='json'){
   assert.ok(out.stats.tokenCountEstimate>0);expectedTokens??=out.stats.tokenCountEstimate;
   assert.equal(out.stats.tokenCountEstimate,expectedTokens);
  }else assert.equal(out.stats,undefined);
 }
}
console.log('PASS live/cache Markdown, optional stats, JSON metadata and unchanged Unicode content');
