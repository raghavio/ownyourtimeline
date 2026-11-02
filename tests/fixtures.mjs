export const initialTweets = [
  { id: '1001', text: 'Election campaign: president and parliament.', political: true },
  { id: '1002', text: 'Coffee, gardens and a quiet mountain walk.' },
];
export function networkBody(tweets = initialTweets) {
  const result = post => ({ __typename: 'Tweet', rest_id: post.id, legacy: {
    full_text: post.text, truncated: Boolean(post.incomplete), is_quote_status: Boolean(post.quote),
    created_at: post.createdAt ?? 'Wed Oct 28 12:00:00 +0000 2026',
    reply_count: post.counts?.replies ?? 12, retweet_count: post.counts?.reposts ?? 34,
    favorite_count: post.counts?.likes ?? 1234, bookmark_count: post.counts?.bookmarks ?? 5,
    entities: { urls: post.links ?? [] },
    ...(post.media ? { extended_entities: { media: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/fixture.jpg', ext_alt_text: 'Mountain lake', original_info: { width: 1200, height: 800 } },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/fixture.jpg', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 256000, url: 'https://video.twimg.com/ext_tw_video/fixture.mp4' }] } },
    ] } } : {}),
  }, core: { user_results: { result: { __typename: 'User', core: { name: post.author?.name ?? 'City Desk', screen_name: post.author?.handle ?? 'citydesk' }, avatar: { image_url: 'https://pbs.twimg.com/profile_images/fixture.jpg' }, is_blue_verified: true } } },
  views: { count: String(post.counts?.views ?? 15300) },
  ...(post.quote ? { quoted_status_result: { result: { __typename: 'Tweet', rest_id: '99001', legacy: { full_text: post.quote }, core: { user_results: { result: { legacy: { name: 'Quoted Author', screen_name: 'quoted_author', profile_image_url_https: 'https://pbs.twimg.com/profile_images/quoted.jpg' } } } } } } } : {}),
  ...(post.note ? { note_tweet: { note_tweet_results: { result: { text: post.note } } } } : {}) });
  return { data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries: [
    ...tweets.map(post => ({ entryId: `tweet-${post.id}`, sortIndex: post.id, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: result(post) } } } })),
    { entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'next-fixture-page' } },
  ] }] } } } };
}
export const networkHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Local network X fixture</title>
<style>body{margin:0;font:15px/20px Arial;color:#0f1419}main{width:600px;margin:auto}nav{position:sticky;top:0;z-index:5;background:white;display:flex;border-bottom:1px solid #eff3f4}nav button{appearance:none;position:relative;display:flex;align-items:center;justify-content:center;flex:1;height:53px;padding:0 16px;border:0;background:transparent;font:500 15px/20px Arial;color:#536471}nav button[aria-selected=true]{font-weight:700;color:#0f1419}nav button[aria-selected=true]::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);height:4px;width:56px;background:#1d9bf0;border-radius:9999px}[data-testid=cellInnerDiv]{position:relative;border-bottom:1px solid #ddd}article{padding:24px;min-height:150px;box-sizing:border-box}header{padding:20px}</style>
</head><body><main data-testid="primaryColumn"><header>Home</header><nav role="tablist"><button role="tab" aria-selected="true">For you</button><button role="tab" aria-selected="false">Following</button></nav><section id="timeline"></section></main>
<script>
window.fixtureAudit=[];window.fixtureFrames=0;
function audit(){window.fixtureFrames++;for(const n of document.querySelectorAll('[data-political=true]'))window.fixtureAudit.push(n.dataset.fixtureId);requestAnimationFrame(audit)}requestAnimationFrame(audit);
function render(body){for(const instruction of body.data.home.home_timeline_urt.instructions){for(const entry of instruction.entries||[]){const post=entry.content?.itemContent?.tweet_results?.result;if(!post)continue;const cell=document.createElement('div');cell.dataset.testid='cellInnerDiv';const article=document.createElement('article');article.dataset.testid='tweet';article.dataset.fixtureId=post.rest_id;const text=post.note_tweet?.note_tweet_results?.result?.text||post.legacy.full_text;article.dataset.political=String(/election|president|parliament/i.test(text));const node=document.createElement('div');node.dataset.testid='tweetText';node.textContent=text;article.append(node);const link=document.createElement('a');link.href='/fixture/status/'+post.rest_id;link.setAttribute('role','link');const time=document.createElement('time');time.textContent='Open post';link.append(time);article.append(link);cell.append(article);document.querySelector('#timeline').append(cell);} }window.lastBody=body;}
window.feed={
 async load(tweets,operation='HomeTimeline',transport='xhr'){
  const url='/i/api/graphql/fixture/'+operation;
  const payload=JSON.stringify({tweets});let body;
  if(transport==='fetch')body=await(await fetch(url,{method:'POST',body:payload})).json();
  else body=await new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST',url);x.onload=()=>{try{resolve(JSON.parse(x.responseText))}catch(e){reject(e)}};x.onerror=reject;x.send(payload)});
  render(body);return body;
 },
 clear(){document.querySelector('#timeline').replaceChildren()},
 navigate(path){history.pushState({},'',path)},
 tab(name){document.querySelectorAll('[role=tab]').forEach(n=>n.setAttribute('aria-selected',String(n.textContent===name)));this.clear()},
};
for(const tab of document.querySelectorAll('[role=tab]'))tab.onclick=()=>{if(tab.getAttribute('aria-selected')!=='true')window.feed.tab(tab.textContent)};
window.feed.load();
</script></body></html>`;
