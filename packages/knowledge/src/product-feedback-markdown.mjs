// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/** Exact source coordinates for feedback prose. This is a closed Markdown subset, not a renderer. */
function fail() { throw new Error("product-feedback: ambiguous or unsupported Markdown target"); }
const need = value => { if (!value) fail(); };
const marker = /^<!-- docsfab:claim:([A-Za-z0-9._:-]+):(start|end) -->$/u;

function title(value) {
  const matches = value.filter(line => /^title:/u.test(line));
  if (matches.length !== 1) return null;
  const text = matches[0].slice(6).trim();
  if (/^"(?:[^"\\]|\\.)*"$/u.test(text)) {
    try { const parsed=JSON.parse(text); return typeof parsed === "string" && parsed.trim() === parsed && parsed && !/[\r\n\u0000]/u.test(parsed) ? parsed : null; } catch { return null; }
  }
  if (/^'(?:[^']|'')*'$/u.test(text)) return text.slice(1,-1).replaceAll("''", "'") || null;
  return text && !/^[\[\]{}&*!|>'"%@`]/u.test(text) && !/[#\r\n]|:\s/u.test(text) ? text : null;
}
function block(line) {
  return /^\s/u.test(line) || /^(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|<|\[[^\]]+\]:|:\s)/u.test(line) ||
    /^(?:[-*_]\s*){3,}$/u.test(line) || /^(?:=+|-+)\s*$/u.test(line) ||
    /^\|/u.test(line) || /^:?-{3,}:?\s*\|/u.test(line);
}
/** Exact LF paragraph bytes, without the final line terminator or a blank/block boundary. */
export function assertProductFeedbackParagraph(value) {
  need(typeof value === "string" && value.length > 0 && !/[\r\u0000]/u.test(value));
  for (const line of value.split("\n")) need(line.trim().length > 0 && !block(line));
  return value;
}
function scan(content) {
  need(typeof content === "string" && !/[\r\u0000]/u.test(content));
  let offset=0, fence=null, comment=false, html=null;
  const rows=content.split(/(?<=\n)/u).map(raw => {
    const row={raw,text:raw.endsWith("\n")?raw.slice(0,-1):raw,start:offset,end:offset+raw.length,kind:"paragraph"};
    offset=row.end;return row;
  });
  let first=0, documentTitle=null;
  if (rows[0]?.text === "---") {
    const end=rows.findIndex((row,index)=>index>0&&row.text==="---");need(end>0);
    documentTitle=title(rows.slice(1,end).map(row=>row.text));first=end+1;
    for(const row of rows.slice(0,first))row.kind="frontmatter";
  }
  for(const [relativeIndex,row] of rows.slice(first).entries()) {
    const line=row.text, opening=/^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if(fence){row.kind="code";if(opening&&opening[0]===fence[0]&&opening.length>=fence.length&&/^ {0,3}(?:`+|~+)\s*$/u.test(line))fence=null;continue;}
    if(comment){row.kind="comment";if(line.includes("-->"))comment=false;continue;}
    if(html){row.kind="html";if(new RegExp(`</${html}\\s*>`,"iu").test(line))html=null;continue;}
    if(opening){row.kind="code";fence=opening;continue;}
    if(marker.test(line)){row.kind="marker";continue;}
    if(line.includes("<!--")){row.kind="comment";comment=line.lastIndexOf("<!--")>line.lastIndexOf("-->");continue;}
    const element=/^ {0,3}<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/u.exec(line);
    if(element){row.kind="html";if(!/\/>\s*$/u.test(line)&&!new RegExp(`</${element[1]}\\s*>`,"iu").test(line))html=element[1];continue;}
    const heading=/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
    if(heading){
      const historical=/^(#{1,6}) (.+)$/u.exec(line);
      row.kind="heading";row.level=heading[1].length;row.heading=historical?.[2].trimEnd()??heading[2].trimEnd();
      row.selectable=historical!==null;continue;
    }
    const underline=/^ {0,3}(=+|-+)\s*$/u.exec(line),index=first+relativeIndex;
    if(underline&&rows[index-1]?.kind==="paragraph"){
      let begin=index-1;while(begin>first&&rows[begin-1].kind==="paragraph")begin--;
      const parts=rows.slice(begin,index);for(const part of parts)part.kind="heading-content";
      row.kind="heading";row.level=underline[1][0]==="="?1:2;row.heading=parts.map(part=>part.text).join("\n");
      row.start=parts[0].start;row.selectable=false;continue;
    }
    row.kind=!line.trim()?"blank":block(line)?"block":"paragraph";
  }
  need(fence===null&&comment===false&&html===null);
  return {rows,first,documentTitle};
}
/** A string selects the one exactly matching H2 section; null selects the document lead. */
export function selectProductFeedbackMarkdownSection(content, heading) {
  need(heading===null||(typeof heading==="string"&&heading.trim().length>0&&!/[\r\n]/u.test(heading)));
  const parsed=scan(content),headings=parsed.rows.filter(row=>row.kind==="heading");
  let start, titleText, level;
  if(heading!==null){
    const matches=headings.filter(row=>row.level===2&&row.selectable&&row.heading===heading);need(matches.length===1);
    start=matches[0].end;titleText=heading;level=2;
  }else{
    level=1;
    if(parsed.documentTitle!==null){
      need(!headings.some(row=>row.level===1));
      start=parsed.rows[parsed.first]?.start??content.length;titleText=parsed.documentTitle;
    }else{
      const root=headings[0];need(root?.level===1&&root.selectable&&headings.filter(row=>row.level===1).length===1);
      need(parsed.rows.filter(row=>row.end<=root.start&&row.kind!=="frontmatter").every(row=>["blank","comment"].includes(row.kind)));
      start=root.end;titleText=root.heading;
    }
  }
  const end=headings.find(row=>row.start>=start&&(level===1||row.level<=2))?.start??content.length;
  return {start,end,heading:titleText,headingLevel:level,rows:parsed.rows.filter(row=>row.start>=start&&row.end<=end)};
}
export function productFeedbackParagraphRange(content, heading, beforeText) {
  assertProductFeedbackParagraph(beforeText);
  const section=selectProductFeedbackMarkdownSection(content,heading),matches=[];
  for(let index=0;index<section.rows.length;index++){
    if(section.rows[index].kind!=="paragraph")continue;
    const first=index;while(index+1<section.rows.length&&section.rows[index+1].kind==="paragraph")index++;
    const group=section.rows.slice(first,index+1);
    if((first===0||section.rows[first-1].kind==="blank")&&(index+1===section.rows.length||section.rows[index+1].kind==="blank")&&
      group.map(row=>row.text).join("\n")===beforeText)matches.push({start:group[0].start,end:group.at(-1).end});
  }
  need(matches.length===1);return matches[0];
}
export function productFeedbackControlledRange(content, heading, claimId) {
  need(typeof claimId==="string"&&/^[A-Za-z0-9._:-]+$/u.test(claimId));
  const open=`<!-- docsfab:claim:${claimId}:start -->`,close=`<!-- docsfab:claim:${claimId}:end -->`;
  need(content.split(open).length===2&&content.split(close).length===2);
  const section=selectProductFeedbackMarkdownSection(content,heading);
  const starts=section.rows.filter(row=>row.kind==="marker"&&row.text===open),ends=section.rows.filter(row=>row.kind==="marker"&&row.text===close);
  need(starts.length===1&&ends.length===1&&starts[0].start<ends[0].start);
  const between=section.rows.filter(row=>row.start>starts[0].start&&row.start<ends[0].start);
  need(between.every(row=>row.kind==="paragraph"||row.kind==="blank"));
  return {start:starts[0].start,end:ends[0].end,heading:section.heading,headingLevel:section.headingLevel};
}

/** True when `text` leaves no code span, bracket, or emphasis run open, so a sentence span cannot split one. */
function proseBoundary(text) {
  let code=null,brackets=[],emphasis=[];
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='\\'){index++;continue;}
    if(char==='`'){
      let end=index+1;while(text[end]==='`')end++;
      const run=text.slice(index,end);if(code===null)code=run;else if(code===run)code=null;
      index=end-1;continue;
    }
    if(code!==null)continue;
    if(char==='['||char==='(')brackets.push(char);
    if(char===']'&&brackets.pop()!=='[')return false;
    if(char===')'&&brackets.pop()!=='(')return false;
    if(char==='*'||char==='_'||char==='~'){
      if(char==='_'&&/[A-Za-z0-9]/u.test(text[index-1]??'')&&/[A-Za-z0-9]/u.test(text[index+1]??''))continue;
      let end=index+1;while(text[end]===char)end++;
      const run=text.slice(index,end);if(emphasis.at(-1)===run)emphasis.pop();else emphasis.push(run);
      index=end-1;
    }
  }
  return code===null&&brackets.length===0&&emphasis.length===0;
}
export function productFeedbackClaimSpanRange(content,heading,paragraph,selection,claimId){
  if(claimId!==undefined){
    need(typeof content==='string'&&typeof claimId==='string'&&claimId.length>0);
    if(content.includes(`<!-- docsfab:claim:${claimId}:start -->`)||content.includes(`<!-- docsfab:claim:${claimId}:end -->`))
      throw new Error("product-feedback: claim-span conflicts with existing controlled claim region");
  }
  need(selection&&Object.getPrototypeOf(selection)===Object.prototype&&
    Object.keys(selection).sort().join(',')==='beforeText,endByte,kind,startByte'&&selection.kind==='claim-span');
  const range=productFeedbackParagraphRange(content,heading,paragraph),data=Buffer.from(paragraph,'utf8');
  need(!/[<>]/u.test(paragraph));
  need(Number.isSafeInteger(selection.startByte)&&Number.isSafeInteger(selection.endByte)&&
    selection.startByte>=0&&selection.endByte>selection.startByte&&selection.endByte<=data.length&&
    typeof selection.beforeText==='string'&&selection.beforeText.length>0);
  // Each part is source text, so a leading U+FEFF must not disappear as a BOM.
  const decode=part=>{try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(part);}catch{fail();}};
  const prefix=decode(data.subarray(0,selection.startByte)),selected=decode(data.subarray(selection.startByte,selection.endByte)),
    suffix=decode(data.subarray(selection.endByte));
  need(selected===selection.beforeText&&selected.trim().length>0&&/[.!?]$/u.test(selected.trimEnd())&&
    (!prefix||(/[.!?]$/u.test(prefix)&&/^\s/u.test(selected)))&&(!suffix||(!/^\s/u.test(suffix)&&/\s$/u.test(selected)))&&
    proseBoundary(prefix)&&proseBoundary(prefix+selected));
  // Coordinates are UTF-8 bytes in the paragraph; exported source offsets are JS string coordinates.
  return {start:range.start+prefix.length,end:range.start+prefix.length+selected.length,
    prefix,suffix,paragraphStart:range.start,paragraphEnd:range.end};
}
