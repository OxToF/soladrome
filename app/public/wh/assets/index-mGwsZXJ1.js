const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/add-BLI1b4Vg.js","assets/solana-DfUZBo5-.js","main.mjs","main.css","assets/util-C_16CLeU.js","assets/wallets-CO31kUi4.js","assets/index.es-BctUhcbn.js","assets/http-D4bz-t0I.js","assets/big-DS5bVq7O.js","assets/all-wallets-CLteY0gJ.js","assets/arrow-bottom-circle-DOp1FB4S.js","assets/app-store-C7V29ULV.js","assets/apple-se2a4wEY.js","assets/arrow-bottom-CFFR1ilL.js","assets/arrow-left-DLdQ0aHn.js","assets/arrow-right-oXSNjapP.js","assets/arrow-top-CY5DKK4-.js","assets/bank-4O4OdZym.js","assets/browser-PaqYV2G-.js","assets/card-CDFqv4gW.js","assets/checkmark-DU_m1Kae.js","assets/checkmark-bold-3klYlNNS.js","assets/chevron-bottom-CWjOGP6f.js","assets/chevron-left-zAHvvWiZ.js","assets/chevron-right-Dm2zpRB2.js","assets/chevron-top-Cn-rIcbY.js","assets/chrome-store-BZqwW6Hh.js","assets/clock-DuT06B8Z.js","assets/close-CjF_Ep9H.js","assets/compass-GxoO8Pcs.js","assets/coinPlaceholder-CY9kWEbl.js","assets/copy-BHfeUuE6.js","assets/cursor-BYqF5Jga.js","assets/cursor-transparent-DYMQbI8v.js","assets/desktop-d3LYaf59.js","assets/disconnect-XFnhVX5A.js","assets/discord-Bqj5x5qO.js","assets/etherscan-B0YzIH5V.js","assets/extension-wG_8dM7g.js","assets/external-link-C3X-9byO.js","assets/facebook-D4BC00_a.js","assets/farcaster-BQYsGVsQ.js","assets/filters-DoaotpMI.js","assets/github-yxjp25_4.js","assets/google-CtVGyPLT.js","assets/help-circle-OAGxn3VO.js","assets/image-DF6TqFdU.js","assets/id-CL1hdM2e.js","assets/info-circle-B5MEeynS.js","assets/lightbulb-CR_yr2tW.js","assets/mail-D8WVvJJr.js","assets/mobile-Bckj14zH.js","assets/more-CWREXonR.js","assets/network-placeholder-DP6zxAN_.js","assets/nftPlaceholder-B9agxjDh.js","assets/off-DHQ-KtSi.js","assets/play-store-D8ptlD0-.js","assets/plus-BQSbft7g.js","assets/qr-code-QIb_CQXv.js","assets/recycle-horizontal-eavnF5SM.js","assets/refresh-C2JaoFVq.js","assets/search-CgrtAbaN.js","assets/send-CARsVK2F.js","assets/swapHorizontal-_z4-1OuV.js","assets/swapHorizontalMedium-CAry4Hmf.js","assets/swapHorizontalBold-BYwXNc3e.js","assets/swapHorizontalRoundedBold-7Mtpnqx5.js","assets/swapVertical-BBT7i4PL.js","assets/telegram-B479ES4b.js","assets/three-dots-B5RlsSo7.js","assets/twitch-DHGRoadh.js","assets/x-CW-eZpBF.js","assets/twitterIcon-lcaqKIu4.js","assets/verify-CRbXaYxm.js","assets/verify-filled-BfpxHeLN.js","assets/wallet-hPVHexkb.js","assets/walletconnect-CuqHlpk0.js","assets/wallet-placeholder-BGfEv5cL.js","assets/warning-circle-C6HHXMO3.js","assets/info-DlK5X5t3.js","assets/exclamation-triangle-CyMB5AXg.js","assets/reown-logo-B3iWN8jq.js"])))=>i.map(i=>d[i]);
import{z as kt,B as Ut,i as T,r as R,a as O,x as E,D as st,o as xt,e as Mt}from"./solana-DfUZBo5-.js";import{_ as c}from"../main.mjs";const $={getSpacingStyles(e,t){if(Array.isArray(e))return e[t]?`var(--wui-spacing-${e[t]})`:void 0;if(typeof e=="string")return`var(--wui-spacing-${e})`},getFormattedDate(e){return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric"}).format(e)},getHostName(e){try{return new URL(e).hostname}catch{return""}},getTruncateString({string:e,charsStart:t,charsEnd:i,truncate:r}){return e.length<=t+i?e:r==="end"?`${e.substring(0,t)}...`:r==="start"?`...${e.substring(e.length-i)}`:`${e.substring(0,Math.floor(t))}...${e.substring(e.length-Math.floor(i))}`},generateAvatarColors(e){const i=e.toLowerCase().replace(/^0x/iu,"").replace(/[^a-f0-9]/gu,"").substring(0,6).padEnd(6,"0"),r=this.hexToRgb(i),o=getComputedStyle(document.documentElement).getPropertyValue("--w3m-border-radius-master"),n=100-3*Number(o?.replace("px","")),a=`${n}% ${n}% at 65% 40%`,l=[];for(let u=0;u<5;u+=1){const p=this.tintColor(r,.15*u);l.push(`rgb(${p[0]}, ${p[1]}, ${p[2]})`)}return`
    --local-color-1: ${l[0]};
    --local-color-2: ${l[1]};
    --local-color-3: ${l[2]};
    --local-color-4: ${l[3]};
    --local-color-5: ${l[4]};
    --local-radial-circle: ${a}
   `},hexToRgb(e){const t=parseInt(e,16),i=t>>16&255,r=t>>8&255,o=t&255;return[i,r,o]},tintColor(e,t){const[i,r,o]=e,s=Math.round(i+(255-i)*t),n=Math.round(r+(255-r)*t),a=Math.round(o+(255-o)*t);return[s,n,a]},isNumber(e){return{number:/^[0-9]+$/u}.number.test(e)},getColorTheme(e){return e||(typeof window<"u"&&window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)")?.matches?"dark":"light":"dark")},splitBalance(e){const t=e.split(".");return t.length===2?[t[0],t[1]]:["0","00"]},roundNumber(e,t,i){return e.toString().length>=t?Number(e).toFixed(i):e},formatNumberToLocalString(e,t=2){return e===void 0?"0.00":typeof e=="number"?e.toLocaleString("en-US",{maximumFractionDigits:t,minimumFractionDigits:t}):parseFloat(e).toLocaleString("en-US",{maximumFractionDigits:t,minimumFractionDigits:t})}};function Ht(e,t){const{kind:i,elements:r}=t;return{kind:i,elements:r,finisher(o){customElements.get(e)||customElements.define(e,o)}}}function jt(e,t){return customElements.get(e)||customElements.define(e,t),t}function L(e){return function(i){return typeof i=="function"?jt(e,i):Ht(e,i)}}/**
 * @license
 * Copyright 2019 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const Y=globalThis,nt=Y.ShadowRoot&&(Y.ShadyCSS===void 0||Y.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,at=Symbol(),_t=new WeakMap;let Ct=class{constructor(t,i,r){if(this._$cssResult$=!0,r!==at)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=i}get styleSheet(){let t=this.o;const i=this.t;if(nt&&t===void 0){const r=i!==void 0&&i.length===1;r&&(t=_t.get(i)),t===void 0&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),r&&_t.set(i,t))}return t}toString(){return this.cssText}};const Bt=e=>new Ct(typeof e=="string"?e:e+"",void 0,at),Ue=(e,...t)=>{const i=e.length===1?e[0]:t.reduce(((r,o,s)=>r+(n=>{if(n._$cssResult$===!0)return n.cssText;if(typeof n=="number")return n;throw Error("Value passed to 'css' function must be a 'css' function result: "+n+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(o)+e[s+1]),e[0]);return new Ct(i,e,at)},Nt=(e,t)=>{if(nt)e.adoptedStyleSheets=t.map((i=>i instanceof CSSStyleSheet?i:i.styleSheet));else for(const i of t){const r=document.createElement("style"),o=Y.litNonce;o!==void 0&&r.setAttribute("nonce",o),r.textContent=i.cssText,e.appendChild(r)}},gt=nt?e=>e:e=>e instanceof CSSStyleSheet?(t=>{let i="";for(const r of t.cssRules)i+=r.cssText;return Bt(i)})(e):e;/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const{is:Wt,defineProperty:Ft,getOwnPropertyDescriptor:qt,getOwnPropertyNames:Gt,getOwnPropertySymbols:Kt,getPrototypeOf:Yt}=Object,tt=globalThis,vt=tt.trustedTypes,Zt=vt?vt.emptyScript:"",Xt=tt.reactiveElementPolyfillSupport,U=(e,t)=>e,X={toAttribute(e,t){switch(t){case Boolean:e=e?Zt:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let i=e;switch(t){case Boolean:i=e!==null;break;case Number:i=e===null?null:Number(e);break;case Object:case Array:try{i=JSON.parse(e)}catch{i=null}}return i}},ct=(e,t)=>!Wt(e,t),ft={attribute:!0,type:String,converter:X,reflect:!1,useDefault:!1,hasChanged:ct};Symbol.metadata??=Symbol("metadata"),tt.litPropertyMetadata??=new WeakMap;let D=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??=[]).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,i=ft){if(i.state&&(i.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((i=Object.create(i)).wrapped=!0),this.elementProperties.set(t,i),!i.noAccessor){const r=Symbol(),o=this.getPropertyDescriptor(t,r,i);o!==void 0&&Ft(this.prototype,t,o)}}static getPropertyDescriptor(t,i,r){const{get:o,set:s}=qt(this.prototype,t)??{get(){return this[i]},set(n){this[i]=n}};return{get:o,set(n){const a=o?.call(this);s?.call(this,n),this.requestUpdate(t,a,r)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??ft}static _$Ei(){if(this.hasOwnProperty(U("elementProperties")))return;const t=Yt(this);t.finalize(),t.l!==void 0&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(U("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(U("properties"))){const i=this.properties,r=[...Gt(i),...Kt(i)];for(const o of r)this.createProperty(o,i[o])}const t=this[Symbol.metadata];if(t!==null){const i=litPropertyMetadata.get(t);if(i!==void 0)for(const[r,o]of i)this.elementProperties.set(r,o)}this._$Eh=new Map;for(const[i,r]of this.elementProperties){const o=this._$Eu(i,r);o!==void 0&&this._$Eh.set(o,i)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){const i=[];if(Array.isArray(t)){const r=new Set(t.flat(1/0).reverse());for(const o of r)i.unshift(gt(o))}else t!==void 0&&i.push(gt(t));return i}static _$Eu(t,i){const r=i.attribute;return r===!1?void 0:typeof r=="string"?r:typeof t=="string"?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise((t=>this.enableUpdating=t)),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach((t=>t(this)))}addController(t){(this._$EO??=new Set).add(t),this.renderRoot!==void 0&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){const t=new Map,i=this.constructor.elementProperties;for(const r of i.keys())this.hasOwnProperty(r)&&(t.set(r,this[r]),delete this[r]);t.size>0&&(this._$Ep=t)}createRenderRoot(){const t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return Nt(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach((t=>t.hostConnected?.()))}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach((t=>t.hostDisconnected?.()))}attributeChangedCallback(t,i,r){this._$AK(t,r)}_$ET(t,i){const r=this.constructor.elementProperties.get(t),o=this.constructor._$Eu(t,r);if(o!==void 0&&r.reflect===!0){const s=(r.converter?.toAttribute!==void 0?r.converter:X).toAttribute(i,r.type);this._$Em=t,s==null?this.removeAttribute(o):this.setAttribute(o,s),this._$Em=null}}_$AK(t,i){const r=this.constructor,o=r._$Eh.get(t);if(o!==void 0&&this._$Em!==o){const s=r.getPropertyOptions(o),n=typeof s.converter=="function"?{fromAttribute:s.converter}:s.converter?.fromAttribute!==void 0?s.converter:X;this._$Em=o;const a=n.fromAttribute(i,s.type);this[o]=a??this._$Ej?.get(o)??a,this._$Em=null}}requestUpdate(t,i,r){if(t!==void 0){const o=this.constructor,s=this[t];if(r??=o.getPropertyOptions(t),!((r.hasChanged??ct)(s,i)||r.useDefault&&r.reflect&&s===this._$Ej?.get(t)&&!this.hasAttribute(o._$Eu(t,r))))return;this.C(t,i,r)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(t,i,{useDefault:r,reflect:o,wrapped:s},n){r&&!(this._$Ej??=new Map).has(t)&&(this._$Ej.set(t,n??i??this[t]),s!==!0||n!==void 0)||(this._$AL.has(t)||(this.hasUpdated||r||(i=void 0),this._$AL.set(t,i)),o===!0&&this._$Em!==t&&(this._$Eq??=new Set).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(i){Promise.reject(i)}const t=this.scheduleUpdate();return t!=null&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[o,s]of this._$Ep)this[o]=s;this._$Ep=void 0}const r=this.constructor.elementProperties;if(r.size>0)for(const[o,s]of r){const{wrapped:n}=s,a=this[o];n!==!0||this._$AL.has(o)||a===void 0||this.C(o,void 0,s,a)}}let t=!1;const i=this._$AL;try{t=this.shouldUpdate(i),t?(this.willUpdate(i),this._$EO?.forEach((r=>r.hostUpdate?.())),this.update(i)):this._$EM()}catch(r){throw t=!1,this._$EM(),r}t&&this._$AE(i)}willUpdate(t){}_$AE(t){this._$EO?.forEach((i=>i.hostUpdated?.())),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&=this._$Eq.forEach((i=>this._$ET(i,this[i]))),this._$EM()}updated(t){}firstUpdated(t){}};D.elementStyles=[],D.shadowRootOptions={mode:"open"},D[U("elementProperties")]=new Map,D[U("finalized")]=new Map,Xt?.({ReactiveElement:D}),(tt.reactiveElementVersions??=[]).push("2.1.1");/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const lt=globalThis,J=lt.trustedTypes,wt=J?J.createPolicy("lit-html",{createHTML:e=>e}):void 0,Tt="$lit$",S=`lit$${Math.random().toFixed(9).slice(2)}$`,Rt="?"+S,Jt=`<${Rt}>`,P=document,H=()=>P.createComment(""),j=e=>e===null||typeof e!="object"&&typeof e!="function",ht=Array.isArray,Qt=e=>ht(e)||typeof e?.[Symbol.iterator]=="function",rt=`[ 	
\f\r]`,k=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,mt=/-->/g,yt=/>/g,b=RegExp(`>|${rt}(?:([^\\s"'>=/]+)(${rt}*=${rt}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),$t=/'/g,St=/"/g,Ot=/^(?:script|style|textarea|title)$/i,te=e=>(t,...i)=>({_$litType$:e,strings:t,values:i}),He=te(1),I=Symbol.for("lit-noChange"),_=Symbol.for("lit-nothing"),Et=new WeakMap,A=P.createTreeWalker(P,129);function Lt(e,t){if(!ht(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return wt!==void 0?wt.createHTML(t):t}const ee=(e,t)=>{const i=e.length-1,r=[];let o,s=t===2?"<svg>":t===3?"<math>":"",n=k;for(let a=0;a<i;a++){const l=e[a];let u,p,d=-1,w=0;for(;w<l.length&&(n.lastIndex=w,p=n.exec(l),p!==null);)w=n.lastIndex,n===k?p[1]==="!--"?n=mt:p[1]!==void 0?n=yt:p[2]!==void 0?(Ot.test(p[2])&&(o=RegExp("</"+p[2],"g")),n=b):p[3]!==void 0&&(n=b):n===b?p[0]===">"?(n=o??k,d=-1):p[1]===void 0?d=-2:(d=n.lastIndex-p[2].length,u=p[1],n=p[3]===void 0?b:p[3]==='"'?St:$t):n===St||n===$t?n=b:n===mt||n===yt?n=k:(n=b,o=void 0);const y=n===b&&e[a+1].startsWith("/>")?" ":"";s+=n===k?l+Jt:d>=0?(r.push(u),l.slice(0,d)+Tt+l.slice(d)+S+y):l+S+(d===-2?a:y)}return[Lt(e,s+(e[i]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),r]};class B{constructor({strings:t,_$litType$:i},r){let o;this.parts=[];let s=0,n=0;const a=t.length-1,l=this.parts,[u,p]=ee(t,i);if(this.el=B.createElement(u,r),A.currentNode=this.el.content,i===2||i===3){const d=this.el.content.firstChild;d.replaceWith(...d.childNodes)}for(;(o=A.nextNode())!==null&&l.length<a;){if(o.nodeType===1){if(o.hasAttributes())for(const d of o.getAttributeNames())if(d.endsWith(Tt)){const w=p[n++],y=o.getAttribute(d).split(S),K=/([.?@])?(.*)/.exec(w);l.push({type:1,index:s,name:K[2],strings:y,ctor:K[1]==="."?re:K[1]==="?"?oe:K[1]==="@"?se:et}),o.removeAttribute(d)}else d.startsWith(S)&&(l.push({type:6,index:s}),o.removeAttribute(d));if(Ot.test(o.tagName)){const d=o.textContent.split(S),w=d.length-1;if(w>0){o.textContent=J?J.emptyScript:"";for(let y=0;y<w;y++)o.append(d[y],H()),A.nextNode(),l.push({type:2,index:++s});o.append(d[w],H())}}}else if(o.nodeType===8)if(o.data===Rt)l.push({type:2,index:s});else{let d=-1;for(;(d=o.data.indexOf(S,d+1))!==-1;)l.push({type:7,index:s}),d+=S.length-1}s++}}static createElement(t,i){const r=P.createElement("template");return r.innerHTML=t,r}}function z(e,t,i=e,r){if(t===I)return t;let o=r!==void 0?i._$Co?.[r]:i._$Cl;const s=j(t)?void 0:t._$litDirective$;return o?.constructor!==s&&(o?._$AO?.(!1),s===void 0?o=void 0:(o=new s(e),o._$AT(e,i,r)),r!==void 0?(i._$Co??=[])[r]=o:i._$Cl=o),o!==void 0&&(t=z(e,o._$AS(e,t.values),o,r)),t}class ie{constructor(t,i){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=i}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){const{el:{content:i},parts:r}=this._$AD,o=(t?.creationScope??P).importNode(i,!0);A.currentNode=o;let s=A.nextNode(),n=0,a=0,l=r[0];for(;l!==void 0;){if(n===l.index){let u;l.type===2?u=new F(s,s.nextSibling,this,t):l.type===1?u=new l.ctor(s,l.name,l.strings,this,t):l.type===6&&(u=new ne(s,this,t)),this._$AV.push(u),l=r[++a]}n!==l?.index&&(s=A.nextNode(),n++)}return A.currentNode=P,o}p(t){let i=0;for(const r of this._$AV)r!==void 0&&(r.strings!==void 0?(r._$AI(t,r,i),i+=r.strings.length-2):r._$AI(t[i])),i++}}class F{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,i,r,o){this.type=2,this._$AH=_,this._$AN=void 0,this._$AA=t,this._$AB=i,this._$AM=r,this.options=o,this._$Cv=o?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode;const i=this._$AM;return i!==void 0&&t?.nodeType===11&&(t=i.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,i=this){t=z(this,t,i),j(t)?t===_||t==null||t===""?(this._$AH!==_&&this._$AR(),this._$AH=_):t!==this._$AH&&t!==I&&this._(t):t._$litType$!==void 0?this.$(t):t.nodeType!==void 0?this.T(t):Qt(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==_&&j(this._$AH)?this._$AA.nextSibling.data=t:this.T(P.createTextNode(t)),this._$AH=t}$(t){const{values:i,_$litType$:r}=t,o=typeof r=="number"?this._$AC(t):(r.el===void 0&&(r.el=B.createElement(Lt(r.h,r.h[0]),this.options)),r);if(this._$AH?._$AD===o)this._$AH.p(i);else{const s=new ie(o,this),n=s.u(this.options);s.p(i),this.T(n),this._$AH=s}}_$AC(t){let i=Et.get(t.strings);return i===void 0&&Et.set(t.strings,i=new B(t)),i}k(t){ht(this._$AH)||(this._$AH=[],this._$AR());const i=this._$AH;let r,o=0;for(const s of t)o===i.length?i.push(r=new F(this.O(H()),this.O(H()),this,this.options)):r=i[o],r._$AI(s),o++;o<i.length&&(this._$AR(r&&r._$AB.nextSibling,o),i.length=o)}_$AR(t=this._$AA.nextSibling,i){for(this._$AP?.(!1,!0,i);t!==this._$AB;){const r=t.nextSibling;t.remove(),t=r}}setConnected(t){this._$AM===void 0&&(this._$Cv=t,this._$AP?.(t))}}class et{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,i,r,o,s){this.type=1,this._$AH=_,this._$AN=void 0,this.element=t,this.name=i,this._$AM=o,this.options=s,r.length>2||r[0]!==""||r[1]!==""?(this._$AH=Array(r.length-1).fill(new String),this.strings=r):this._$AH=_}_$AI(t,i=this,r,o){const s=this.strings;let n=!1;if(s===void 0)t=z(this,t,i,0),n=!j(t)||t!==this._$AH&&t!==I,n&&(this._$AH=t);else{const a=t;let l,u;for(t=s[0],l=0;l<s.length-1;l++)u=z(this,a[r+l],i,l),u===I&&(u=this._$AH[l]),n||=!j(u)||u!==this._$AH[l],u===_?t=_:t!==_&&(t+=(u??"")+s[l+1]),this._$AH[l]=u}n&&!o&&this.j(t)}j(t){t===_?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}}class re extends et{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===_?void 0:t}}class oe extends et{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==_)}}class se extends et{constructor(t,i,r,o,s){super(t,i,r,o,s),this.type=5}_$AI(t,i=this){if((t=z(this,t,i,0)??_)===I)return;const r=this._$AH,o=t===_&&r!==_||t.capture!==r.capture||t.once!==r.once||t.passive!==r.passive,s=t!==_&&(r===_||o);o&&this.element.removeEventListener(this.name,this,r),s&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}}class ne{constructor(t,i,r){this.element=t,this.type=6,this._$AN=void 0,this._$AM=i,this.options=r}get _$AU(){return this._$AM._$AU}_$AI(t){z(this,t)}}const ae=lt.litHtmlPolyfillSupport;ae?.(B,F),(lt.litHtmlVersions??=[]).push("3.3.1");const ce=(e,t,i)=>{const r=i?.renderBefore??t;let o=r._$litPart$;if(o===void 0){const s=i?.renderBefore??null;r._$litPart$=o=new F(t.insertBefore(H(),s),s,void 0,i??{})}return o._$AI(e),o};/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const ut=globalThis;let Z=class extends D{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const t=super.createRenderRoot();return this.renderOptions.renderBefore??=t.firstChild,t}update(t){const i=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=ce(i,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return I}};Z._$litElement$=!0,Z.finalized=!0,ut.litElementHydrateSupport?.({LitElement:Z});const le=ut.litElementPolyfillSupport;le?.({LitElement:Z});(ut.litElementVersions??=[]).push("4.2.1");/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const he={attribute:!0,type:String,converter:X,reflect:!1,hasChanged:ct},ue=(e=he,t,i)=>{const{kind:r,metadata:o}=i;let s=globalThis.litPropertyMetadata.get(o);if(s===void 0&&globalThis.litPropertyMetadata.set(o,s=new Map),r==="setter"&&((e=Object.create(e)).wrapped=!0),s.set(i.name,e),r==="accessor"){const{name:n}=i;return{set(a){const l=t.get.call(this);t.set.call(this,a),this.requestUpdate(n,l,e)},init(a){return a!==void 0&&this.C(n,void 0,e,a),a}}}if(r==="setter"){const{name:n}=i;return function(a){const l=this[n];t.call(this,a),this.requestUpdate(n,l,e)}}throw Error("Unsupported decorator location: "+r)};function de(e){return(t,i)=>typeof i=="object"?ue(e,t,i):((r,o,s)=>{const n=o.hasOwnProperty(s);return o.constructor.createProperty(s,r),n?Object.getOwnPropertyDescriptor(o,s):void 0})(e,t,i)}/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */function Be(e){return de({...e,state:!0,attribute:!1})}/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const pe={attribute:!0,type:String,converter:Ut,reflect:!1,hasChanged:kt},_e=(e=pe,t,i)=>{const{kind:r,metadata:o}=i;let s=globalThis.litPropertyMetadata.get(o);if(s===void 0&&globalThis.litPropertyMetadata.set(o,s=new Map),r==="setter"&&((e=Object.create(e)).wrapped=!0),s.set(i.name,e),r==="accessor"){const{name:n}=i;return{set(a){const l=t.get.call(this);t.set.call(this,a),this.requestUpdate(n,l,e)},init(a){return a!==void 0&&this.C(n,void 0,e,a),a}}}if(r==="setter"){const{name:n}=i;return function(a){const l=this[n];t.call(this,a),this.requestUpdate(n,l,e)}}throw Error("Unsupported decorator location: "+r)};function h(e){return(t,i)=>typeof i=="object"?_e(e,t,i):((r,o,s)=>{const n=o.hasOwnProperty(s);return o.constructor.createProperty(s,r),n?Object.getOwnPropertyDescriptor(o,s):void 0})(e,t,i)}const ge=T`
  :host {
    display: flex;
    width: inherit;
    height: inherit;
  }
`;var v=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let g=class extends O{render(){return this.style.cssText=`
      flex-direction: ${this.flexDirection};
      flex-wrap: ${this.flexWrap};
      flex-basis: ${this.flexBasis};
      flex-grow: ${this.flexGrow};
      flex-shrink: ${this.flexShrink};
      align-items: ${this.alignItems};
      justify-content: ${this.justifyContent};
      column-gap: ${this.columnGap&&`var(--wui-spacing-${this.columnGap})`};
      row-gap: ${this.rowGap&&`var(--wui-spacing-${this.rowGap})`};
      gap: ${this.gap&&`var(--wui-spacing-${this.gap})`};
      padding-top: ${this.padding&&$.getSpacingStyles(this.padding,0)};
      padding-right: ${this.padding&&$.getSpacingStyles(this.padding,1)};
      padding-bottom: ${this.padding&&$.getSpacingStyles(this.padding,2)};
      padding-left: ${this.padding&&$.getSpacingStyles(this.padding,3)};
      margin-top: ${this.margin&&$.getSpacingStyles(this.margin,0)};
      margin-right: ${this.margin&&$.getSpacingStyles(this.margin,1)};
      margin-bottom: ${this.margin&&$.getSpacingStyles(this.margin,2)};
      margin-left: ${this.margin&&$.getSpacingStyles(this.margin,3)};
    `,E`<slot></slot>`}};g.styles=[R,ge];v([h()],g.prototype,"flexDirection",void 0);v([h()],g.prototype,"flexWrap",void 0);v([h()],g.prototype,"flexBasis",void 0);v([h()],g.prototype,"flexGrow",void 0);v([h()],g.prototype,"flexShrink",void 0);v([h()],g.prototype,"alignItems",void 0);v([h()],g.prototype,"justifyContent",void 0);v([h()],g.prototype,"columnGap",void 0);v([h()],g.prototype,"rowGap",void 0);v([h()],g.prototype,"gap",void 0);v([h()],g.prototype,"padding",void 0);v([h()],g.prototype,"margin",void 0);g=v([L("wui-flex")],g);/**
 * @license
 * Copyright 2018 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const We=e=>e??_;/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const ve=e=>e===null||typeof e!="object"&&typeof e!="function",fe=e=>e.strings===void 0;/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const Dt={ATTRIBUTE:1,CHILD:2},It=e=>(...t)=>({_$litDirective$:e,values:t});let zt=class{constructor(t){}get _$AU(){return this._$AM._$AU}_$AT(t,i,r){this._$Ct=t,this._$AM=i,this._$Ci=r}_$AS(t,i){return this.update(t,i)}update(t,i){return this.render(...i)}};/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const M=(e,t)=>{const i=e._$AN;if(i===void 0)return!1;for(const r of i)r._$AO?.(t,!1),M(r,t);return!0},Q=e=>{let t,i;do{if((t=e._$AM)===void 0)break;i=t._$AN,i.delete(e),e=t}while(i?.size===0)},Vt=e=>{for(let t;t=e._$AM;e=t){let i=t._$AN;if(i===void 0)t._$AN=i=new Set;else if(i.has(e))break;i.add(e),ye(t)}};function we(e){this._$AN!==void 0?(Q(this),this._$AM=e,Vt(this)):this._$AM=e}function me(e,t=!1,i=0){const r=this._$AH,o=this._$AN;if(o!==void 0&&o.size!==0)if(t)if(Array.isArray(r))for(let s=i;s<r.length;s++)M(r[s],!1),Q(r[s]);else r!=null&&(M(r,!1),Q(r));else M(this,e)}const ye=e=>{e.type==Dt.CHILD&&(e._$AP??=me,e._$AQ??=we)};class $e extends zt{constructor(){super(...arguments),this._$AN=void 0}_$AT(t,i,r){super._$AT(t,i,r),Vt(this),this.isConnected=t._$AU}_$AO(t,i=!0){t!==this.isConnected&&(this.isConnected=t,t?this.reconnected?.():this.disconnected?.()),i&&(M(this,t),Q(this))}setValue(t){if(fe(this._$Ct))this._$Ct._$AI(t,this);else{const i=[...this._$Ct._$AH];i[this._$Ci]=t,this._$Ct._$AI(i,this,0)}}disconnected(){}reconnected(){}}/**
 * @license
 * Copyright 2021 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */class Se{constructor(t){this.G=t}disconnect(){this.G=void 0}reconnect(t){this.G=t}deref(){return this.G}}class Ee{constructor(){this.Y=void 0,this.Z=void 0}get(){return this.Y}pause(){this.Y??=new Promise((t=>this.Z=t))}resume(){this.Z?.(),this.Y=this.Z=void 0}}/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const bt=e=>!ve(e)&&typeof e.then=="function",At=1073741823;class be extends $e{constructor(){super(...arguments),this._$Cwt=At,this._$Cbt=[],this._$CK=new Se(this),this._$CX=new Ee}render(...t){return t.find((i=>!bt(i)))??st}update(t,i){const r=this._$Cbt;let o=r.length;this._$Cbt=i;const s=this._$CK,n=this._$CX;this.isConnected||this.disconnected();for(let a=0;a<i.length&&!(a>this._$Cwt);a++){const l=i[a];if(!bt(l))return this._$Cwt=a,l;a<o&&l===r[a]||(this._$Cwt=At,o=0,Promise.resolve(l).then((async u=>{for(;n.get();)await n.get();const p=s.deref();if(p!==void 0){const d=p._$Cbt.indexOf(l);d>-1&&d<p._$Cwt&&(p._$Cwt=d,p.setValue(u))}})))}return st}disconnected(){this._$CK.disconnect(),this._$CX.pause()}reconnected(){this._$CK.reconnect(this),this._$CX.resume()}}const Ae=It(be);class Pe{constructor(){this.cache=new Map}set(t,i){this.cache.set(t,i)}get(t){return this.cache.get(t)}has(t){return this.cache.has(t)}delete(t){this.cache.delete(t)}clear(){this.cache.clear()}}const ot=new Pe,xe=T`
  :host {
    display: flex;
    aspect-ratio: var(--local-aspect-ratio);
    color: var(--local-color);
    width: var(--local-width);
  }

  svg {
    width: inherit;
    height: inherit;
    object-fit: contain;
    object-position: center;
  }

  .fallback {
    width: var(--local-width);
    height: var(--local-height);
  }
`;var q=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};const Pt={add:async()=>(await c(async()=>{const{addSvg:e}=await import("./add-BLI1b4Vg.js");return{addSvg:e}},__vite__mapDeps([0,1,2,3,4,5,6,7,8]))).addSvg,allWallets:async()=>(await c(async()=>{const{allWalletsSvg:e}=await import("./all-wallets-CLteY0gJ.js");return{allWalletsSvg:e}},__vite__mapDeps([9,1,2,3,4,5,6,7,8]))).allWalletsSvg,arrowBottomCircle:async()=>(await c(async()=>{const{arrowBottomCircleSvg:e}=await import("./arrow-bottom-circle-DOp1FB4S.js");return{arrowBottomCircleSvg:e}},__vite__mapDeps([10,1,2,3,4,5,6,7,8]))).arrowBottomCircleSvg,appStore:async()=>(await c(async()=>{const{appStoreSvg:e}=await import("./app-store-C7V29ULV.js");return{appStoreSvg:e}},__vite__mapDeps([11,1,2,3,4,5,6,7,8]))).appStoreSvg,apple:async()=>(await c(async()=>{const{appleSvg:e}=await import("./apple-se2a4wEY.js");return{appleSvg:e}},__vite__mapDeps([12,1,2,3,4,5,6,7,8]))).appleSvg,arrowBottom:async()=>(await c(async()=>{const{arrowBottomSvg:e}=await import("./arrow-bottom-CFFR1ilL.js");return{arrowBottomSvg:e}},__vite__mapDeps([13,1,2,3,4,5,6,7,8]))).arrowBottomSvg,arrowLeft:async()=>(await c(async()=>{const{arrowLeftSvg:e}=await import("./arrow-left-DLdQ0aHn.js");return{arrowLeftSvg:e}},__vite__mapDeps([14,1,2,3,4,5,6,7,8]))).arrowLeftSvg,arrowRight:async()=>(await c(async()=>{const{arrowRightSvg:e}=await import("./arrow-right-oXSNjapP.js");return{arrowRightSvg:e}},__vite__mapDeps([15,1,2,3,4,5,6,7,8]))).arrowRightSvg,arrowTop:async()=>(await c(async()=>{const{arrowTopSvg:e}=await import("./arrow-top-CY5DKK4-.js");return{arrowTopSvg:e}},__vite__mapDeps([16,1,2,3,4,5,6,7,8]))).arrowTopSvg,bank:async()=>(await c(async()=>{const{bankSvg:e}=await import("./bank-4O4OdZym.js");return{bankSvg:e}},__vite__mapDeps([17,1,2,3,4,5,6,7,8]))).bankSvg,browser:async()=>(await c(async()=>{const{browserSvg:e}=await import("./browser-PaqYV2G-.js");return{browserSvg:e}},__vite__mapDeps([18,1,2,3,4,5,6,7,8]))).browserSvg,card:async()=>(await c(async()=>{const{cardSvg:e}=await import("./card-CDFqv4gW.js");return{cardSvg:e}},__vite__mapDeps([19,1,2,3,4,5,6,7,8]))).cardSvg,checkmark:async()=>(await c(async()=>{const{checkmarkSvg:e}=await import("./checkmark-DU_m1Kae.js");return{checkmarkSvg:e}},__vite__mapDeps([20,1,2,3,4,5,6,7,8]))).checkmarkSvg,checkmarkBold:async()=>(await c(async()=>{const{checkmarkBoldSvg:e}=await import("./checkmark-bold-3klYlNNS.js");return{checkmarkBoldSvg:e}},__vite__mapDeps([21,1,2,3,4,5,6,7,8]))).checkmarkBoldSvg,chevronBottom:async()=>(await c(async()=>{const{chevronBottomSvg:e}=await import("./chevron-bottom-CWjOGP6f.js");return{chevronBottomSvg:e}},__vite__mapDeps([22,1,2,3,4,5,6,7,8]))).chevronBottomSvg,chevronLeft:async()=>(await c(async()=>{const{chevronLeftSvg:e}=await import("./chevron-left-zAHvvWiZ.js");return{chevronLeftSvg:e}},__vite__mapDeps([23,1,2,3,4,5,6,7,8]))).chevronLeftSvg,chevronRight:async()=>(await c(async()=>{const{chevronRightSvg:e}=await import("./chevron-right-Dm2zpRB2.js");return{chevronRightSvg:e}},__vite__mapDeps([24,1,2,3,4,5,6,7,8]))).chevronRightSvg,chevronTop:async()=>(await c(async()=>{const{chevronTopSvg:e}=await import("./chevron-top-Cn-rIcbY.js");return{chevronTopSvg:e}},__vite__mapDeps([25,1,2,3,4,5,6,7,8]))).chevronTopSvg,chromeStore:async()=>(await c(async()=>{const{chromeStoreSvg:e}=await import("./chrome-store-BZqwW6Hh.js");return{chromeStoreSvg:e}},__vite__mapDeps([26,1,2,3,4,5,6,7,8]))).chromeStoreSvg,clock:async()=>(await c(async()=>{const{clockSvg:e}=await import("./clock-DuT06B8Z.js");return{clockSvg:e}},__vite__mapDeps([27,1,2,3,4,5,6,7,8]))).clockSvg,close:async()=>(await c(async()=>{const{closeSvg:e}=await import("./close-CjF_Ep9H.js");return{closeSvg:e}},__vite__mapDeps([28,1,2,3,4,5,6,7,8]))).closeSvg,compass:async()=>(await c(async()=>{const{compassSvg:e}=await import("./compass-GxoO8Pcs.js");return{compassSvg:e}},__vite__mapDeps([29,1,2,3,4,5,6,7,8]))).compassSvg,coinPlaceholder:async()=>(await c(async()=>{const{coinPlaceholderSvg:e}=await import("./coinPlaceholder-CY9kWEbl.js");return{coinPlaceholderSvg:e}},__vite__mapDeps([30,1,2,3,4,5,6,7,8]))).coinPlaceholderSvg,copy:async()=>(await c(async()=>{const{copySvg:e}=await import("./copy-BHfeUuE6.js");return{copySvg:e}},__vite__mapDeps([31,1,2,3,4,5,6,7,8]))).copySvg,cursor:async()=>(await c(async()=>{const{cursorSvg:e}=await import("./cursor-BYqF5Jga.js");return{cursorSvg:e}},__vite__mapDeps([32,1,2,3,4,5,6,7,8]))).cursorSvg,cursorTransparent:async()=>(await c(async()=>{const{cursorTransparentSvg:e}=await import("./cursor-transparent-DYMQbI8v.js");return{cursorTransparentSvg:e}},__vite__mapDeps([33,1,2,3,4,5,6,7,8]))).cursorTransparentSvg,desktop:async()=>(await c(async()=>{const{desktopSvg:e}=await import("./desktop-d3LYaf59.js");return{desktopSvg:e}},__vite__mapDeps([34,1,2,3,4,5,6,7,8]))).desktopSvg,disconnect:async()=>(await c(async()=>{const{disconnectSvg:e}=await import("./disconnect-XFnhVX5A.js");return{disconnectSvg:e}},__vite__mapDeps([35,1,2,3,4,5,6,7,8]))).disconnectSvg,discord:async()=>(await c(async()=>{const{discordSvg:e}=await import("./discord-Bqj5x5qO.js");return{discordSvg:e}},__vite__mapDeps([36,1,2,3,4,5,6,7,8]))).discordSvg,etherscan:async()=>(await c(async()=>{const{etherscanSvg:e}=await import("./etherscan-B0YzIH5V.js");return{etherscanSvg:e}},__vite__mapDeps([37,1,2,3,4,5,6,7,8]))).etherscanSvg,extension:async()=>(await c(async()=>{const{extensionSvg:e}=await import("./extension-wG_8dM7g.js");return{extensionSvg:e}},__vite__mapDeps([38,1,2,3,4,5,6,7,8]))).extensionSvg,externalLink:async()=>(await c(async()=>{const{externalLinkSvg:e}=await import("./external-link-C3X-9byO.js");return{externalLinkSvg:e}},__vite__mapDeps([39,1,2,3,4,5,6,7,8]))).externalLinkSvg,facebook:async()=>(await c(async()=>{const{facebookSvg:e}=await import("./facebook-D4BC00_a.js");return{facebookSvg:e}},__vite__mapDeps([40,1,2,3,4,5,6,7,8]))).facebookSvg,farcaster:async()=>(await c(async()=>{const{farcasterSvg:e}=await import("./farcaster-BQYsGVsQ.js");return{farcasterSvg:e}},__vite__mapDeps([41,1,2,3,4,5,6,7,8]))).farcasterSvg,filters:async()=>(await c(async()=>{const{filtersSvg:e}=await import("./filters-DoaotpMI.js");return{filtersSvg:e}},__vite__mapDeps([42,1,2,3,4,5,6,7,8]))).filtersSvg,github:async()=>(await c(async()=>{const{githubSvg:e}=await import("./github-yxjp25_4.js");return{githubSvg:e}},__vite__mapDeps([43,1,2,3,4,5,6,7,8]))).githubSvg,google:async()=>(await c(async()=>{const{googleSvg:e}=await import("./google-CtVGyPLT.js");return{googleSvg:e}},__vite__mapDeps([44,1,2,3,4,5,6,7,8]))).googleSvg,helpCircle:async()=>(await c(async()=>{const{helpCircleSvg:e}=await import("./help-circle-OAGxn3VO.js");return{helpCircleSvg:e}},__vite__mapDeps([45,1,2,3,4,5,6,7,8]))).helpCircleSvg,image:async()=>(await c(async()=>{const{imageSvg:e}=await import("./image-DF6TqFdU.js");return{imageSvg:e}},__vite__mapDeps([46,1,2,3,4,5,6,7,8]))).imageSvg,id:async()=>(await c(async()=>{const{idSvg:e}=await import("./id-CL1hdM2e.js");return{idSvg:e}},__vite__mapDeps([47,1,2,3,4,5,6,7,8]))).idSvg,infoCircle:async()=>(await c(async()=>{const{infoCircleSvg:e}=await import("./info-circle-B5MEeynS.js");return{infoCircleSvg:e}},__vite__mapDeps([48,1,2,3,4,5,6,7,8]))).infoCircleSvg,lightbulb:async()=>(await c(async()=>{const{lightbulbSvg:e}=await import("./lightbulb-CR_yr2tW.js");return{lightbulbSvg:e}},__vite__mapDeps([49,1,2,3,4,5,6,7,8]))).lightbulbSvg,mail:async()=>(await c(async()=>{const{mailSvg:e}=await import("./mail-D8WVvJJr.js");return{mailSvg:e}},__vite__mapDeps([50,1,2,3,4,5,6,7,8]))).mailSvg,mobile:async()=>(await c(async()=>{const{mobileSvg:e}=await import("./mobile-Bckj14zH.js");return{mobileSvg:e}},__vite__mapDeps([51,1,2,3,4,5,6,7,8]))).mobileSvg,more:async()=>(await c(async()=>{const{moreSvg:e}=await import("./more-CWREXonR.js");return{moreSvg:e}},__vite__mapDeps([52,1,2,3,4,5,6,7,8]))).moreSvg,networkPlaceholder:async()=>(await c(async()=>{const{networkPlaceholderSvg:e}=await import("./network-placeholder-DP6zxAN_.js");return{networkPlaceholderSvg:e}},__vite__mapDeps([53,1,2,3,4,5,6,7,8]))).networkPlaceholderSvg,nftPlaceholder:async()=>(await c(async()=>{const{nftPlaceholderSvg:e}=await import("./nftPlaceholder-B9agxjDh.js");return{nftPlaceholderSvg:e}},__vite__mapDeps([54,1,2,3,4,5,6,7,8]))).nftPlaceholderSvg,off:async()=>(await c(async()=>{const{offSvg:e}=await import("./off-DHQ-KtSi.js");return{offSvg:e}},__vite__mapDeps([55,1,2,3,4,5,6,7,8]))).offSvg,playStore:async()=>(await c(async()=>{const{playStoreSvg:e}=await import("./play-store-D8ptlD0-.js");return{playStoreSvg:e}},__vite__mapDeps([56,1,2,3,4,5,6,7,8]))).playStoreSvg,plus:async()=>(await c(async()=>{const{plusSvg:e}=await import("./plus-BQSbft7g.js");return{plusSvg:e}},__vite__mapDeps([57,1,2,3,4,5,6,7,8]))).plusSvg,qrCode:async()=>(await c(async()=>{const{qrCodeIcon:e}=await import("./qr-code-QIb_CQXv.js");return{qrCodeIcon:e}},__vite__mapDeps([58,1,2,3,4,5,6,7,8]))).qrCodeIcon,recycleHorizontal:async()=>(await c(async()=>{const{recycleHorizontalSvg:e}=await import("./recycle-horizontal-eavnF5SM.js");return{recycleHorizontalSvg:e}},__vite__mapDeps([59,1,2,3,4,5,6,7,8]))).recycleHorizontalSvg,refresh:async()=>(await c(async()=>{const{refreshSvg:e}=await import("./refresh-C2JaoFVq.js");return{refreshSvg:e}},__vite__mapDeps([60,1,2,3,4,5,6,7,8]))).refreshSvg,search:async()=>(await c(async()=>{const{searchSvg:e}=await import("./search-CgrtAbaN.js");return{searchSvg:e}},__vite__mapDeps([61,1,2,3,4,5,6,7,8]))).searchSvg,send:async()=>(await c(async()=>{const{sendSvg:e}=await import("./send-CARsVK2F.js");return{sendSvg:e}},__vite__mapDeps([62,1,2,3,4,5,6,7,8]))).sendSvg,swapHorizontal:async()=>(await c(async()=>{const{swapHorizontalSvg:e}=await import("./swapHorizontal-_z4-1OuV.js");return{swapHorizontalSvg:e}},__vite__mapDeps([63,1,2,3,4,5,6,7,8]))).swapHorizontalSvg,swapHorizontalMedium:async()=>(await c(async()=>{const{swapHorizontalMediumSvg:e}=await import("./swapHorizontalMedium-CAry4Hmf.js");return{swapHorizontalMediumSvg:e}},__vite__mapDeps([64,1,2,3,4,5,6,7,8]))).swapHorizontalMediumSvg,swapHorizontalBold:async()=>(await c(async()=>{const{swapHorizontalBoldSvg:e}=await import("./swapHorizontalBold-BYwXNc3e.js");return{swapHorizontalBoldSvg:e}},__vite__mapDeps([65,1,2,3,4,5,6,7,8]))).swapHorizontalBoldSvg,swapHorizontalRoundedBold:async()=>(await c(async()=>{const{swapHorizontalRoundedBoldSvg:e}=await import("./swapHorizontalRoundedBold-7Mtpnqx5.js");return{swapHorizontalRoundedBoldSvg:e}},__vite__mapDeps([66,1,2,3,4,5,6,7,8]))).swapHorizontalRoundedBoldSvg,swapVertical:async()=>(await c(async()=>{const{swapVerticalSvg:e}=await import("./swapVertical-BBT7i4PL.js");return{swapVerticalSvg:e}},__vite__mapDeps([67,1,2,3,4,5,6,7,8]))).swapVerticalSvg,telegram:async()=>(await c(async()=>{const{telegramSvg:e}=await import("./telegram-B479ES4b.js");return{telegramSvg:e}},__vite__mapDeps([68,1,2,3,4,5,6,7,8]))).telegramSvg,threeDots:async()=>(await c(async()=>{const{threeDotsSvg:e}=await import("./three-dots-B5RlsSo7.js");return{threeDotsSvg:e}},__vite__mapDeps([69,1,2,3,4,5,6,7,8]))).threeDotsSvg,twitch:async()=>(await c(async()=>{const{twitchSvg:e}=await import("./twitch-DHGRoadh.js");return{twitchSvg:e}},__vite__mapDeps([70,1,2,3,4,5,6,7,8]))).twitchSvg,twitter:async()=>(await c(async()=>{const{xSvg:e}=await import("./x-CW-eZpBF.js");return{xSvg:e}},__vite__mapDeps([71,1,2,3,4,5,6,7,8]))).xSvg,twitterIcon:async()=>(await c(async()=>{const{twitterIconSvg:e}=await import("./twitterIcon-lcaqKIu4.js");return{twitterIconSvg:e}},__vite__mapDeps([72,1,2,3,4,5,6,7,8]))).twitterIconSvg,verify:async()=>(await c(async()=>{const{verifySvg:e}=await import("./verify-CRbXaYxm.js");return{verifySvg:e}},__vite__mapDeps([73,1,2,3,4,5,6,7,8]))).verifySvg,verifyFilled:async()=>(await c(async()=>{const{verifyFilledSvg:e}=await import("./verify-filled-BfpxHeLN.js");return{verifyFilledSvg:e}},__vite__mapDeps([74,1,2,3,4,5,6,7,8]))).verifyFilledSvg,wallet:async()=>(await c(async()=>{const{walletSvg:e}=await import("./wallet-hPVHexkb.js");return{walletSvg:e}},__vite__mapDeps([75,1,2,3,4,5,6,7,8]))).walletSvg,walletConnect:async()=>(await c(async()=>{const{walletConnectSvg:e}=await import("./walletconnect-CuqHlpk0.js");return{walletConnectSvg:e}},__vite__mapDeps([76,1,2,3,4,5,6,7,8]))).walletConnectSvg,walletConnectLightBrown:async()=>(await c(async()=>{const{walletConnectLightBrownSvg:e}=await import("./walletconnect-CuqHlpk0.js");return{walletConnectLightBrownSvg:e}},__vite__mapDeps([76,1,2,3,4,5,6,7,8]))).walletConnectLightBrownSvg,walletConnectBrown:async()=>(await c(async()=>{const{walletConnectBrownSvg:e}=await import("./walletconnect-CuqHlpk0.js");return{walletConnectBrownSvg:e}},__vite__mapDeps([76,1,2,3,4,5,6,7,8]))).walletConnectBrownSvg,walletPlaceholder:async()=>(await c(async()=>{const{walletPlaceholderSvg:e}=await import("./wallet-placeholder-BGfEv5cL.js");return{walletPlaceholderSvg:e}},__vite__mapDeps([77,1,2,3,4,5,6,7,8]))).walletPlaceholderSvg,warningCircle:async()=>(await c(async()=>{const{warningCircleSvg:e}=await import("./warning-circle-C6HHXMO3.js");return{warningCircleSvg:e}},__vite__mapDeps([78,1,2,3,4,5,6,7,8]))).warningCircleSvg,x:async()=>(await c(async()=>{const{xSvg:e}=await import("./x-CW-eZpBF.js");return{xSvg:e}},__vite__mapDeps([71,1,2,3,4,5,6,7,8]))).xSvg,info:async()=>(await c(async()=>{const{infoSvg:e}=await import("./info-DlK5X5t3.js");return{infoSvg:e}},__vite__mapDeps([79,1,2,3,4,5,6,7,8]))).infoSvg,exclamationTriangle:async()=>(await c(async()=>{const{exclamationTriangleSvg:e}=await import("./exclamation-triangle-CyMB5AXg.js");return{exclamationTriangleSvg:e}},__vite__mapDeps([80,1,2,3,4,5,6,7,8]))).exclamationTriangleSvg,reown:async()=>(await c(async()=>{const{reownSvg:e}=await import("./reown-logo-B3iWN8jq.js");return{reownSvg:e}},__vite__mapDeps([81,1,2,3,4,5,6,7,8]))).reownSvg};async function Ce(e){if(ot.has(e))return ot.get(e);const i=(Pt[e]??Pt.copy)();return ot.set(e,i),i}let x=class extends O{constructor(){super(...arguments),this.size="md",this.name="copy",this.color="fg-300",this.aspectRatio="1 / 1"}render(){return this.style.cssText=`
      --local-color: ${`var(--wui-color-${this.color});`}
      --local-width: ${`var(--wui-icon-size-${this.size});`}
      --local-aspect-ratio: ${this.aspectRatio}
    `,E`${Ae(Ce(this.name),E`<div class="fallback"></div>`)}`}};x.styles=[R,xt,xe];q([h()],x.prototype,"size",void 0);q([h()],x.prototype,"name",void 0);q([h()],x.prototype,"color",void 0);q([h()],x.prototype,"aspectRatio",void 0);x=q([L("wui-icon")],x);/**
 * @license
 * Copyright 2018 Google LLC
 * SPDX-License-Identifier: BSD-3-Clause
 */const Te=It(class extends zt{constructor(e){if(super(e),e.type!==Dt.ATTRIBUTE||e.name!=="class"||e.strings?.length>2)throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.")}render(e){return" "+Object.keys(e).filter((t=>e[t])).join(" ")+" "}update(e,[t]){if(this.st===void 0){this.st=new Set,e.strings!==void 0&&(this.nt=new Set(e.strings.join(" ").split(/\s/).filter((r=>r!==""))));for(const r in t)t[r]&&!this.nt?.has(r)&&this.st.add(r);return this.render(t)}const i=e.element.classList;for(const r of this.st)r in t||(i.remove(r),this.st.delete(r));for(const r in t){const o=!!t[r];o===this.st.has(r)||this.nt?.has(r)||(o?(i.add(r),this.st.add(r)):(i.remove(r),this.st.delete(r)))}return st}}),Re=T`
  :host {
    display: inline-flex !important;
  }

  slot {
    width: 100%;
    display: inline-block;
    font-style: normal;
    font-family: var(--wui-font-family);
    font-feature-settings:
      'tnum' on,
      'lnum' on,
      'case' on;
    line-height: 130%;
    font-weight: var(--wui-font-weight-regular);
    overflow: inherit;
    text-overflow: inherit;
    text-align: var(--local-align);
    color: var(--local-color);
  }

  .wui-line-clamp-1 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
  }

  .wui-line-clamp-2 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .wui-font-medium-400 {
    font-size: var(--wui-font-size-medium);
    font-weight: var(--wui-font-weight-light);
    letter-spacing: var(--wui-letter-spacing-medium);
  }

  .wui-font-medium-600 {
    font-size: var(--wui-font-size-medium);
    letter-spacing: var(--wui-letter-spacing-medium);
  }

  .wui-font-title-600 {
    font-size: var(--wui-font-size-title);
    letter-spacing: var(--wui-letter-spacing-title);
  }

  .wui-font-title-6-600 {
    font-size: var(--wui-font-size-title-6);
    letter-spacing: var(--wui-letter-spacing-title-6);
  }

  .wui-font-mini-700 {
    font-size: var(--wui-font-size-mini);
    letter-spacing: var(--wui-letter-spacing-mini);
    text-transform: uppercase;
  }

  .wui-font-large-500,
  .wui-font-large-600,
  .wui-font-large-700 {
    font-size: var(--wui-font-size-large);
    letter-spacing: var(--wui-letter-spacing-large);
  }

  .wui-font-2xl-500,
  .wui-font-2xl-600,
  .wui-font-2xl-700 {
    font-size: var(--wui-font-size-2xl);
    letter-spacing: var(--wui-letter-spacing-2xl);
  }

  .wui-font-paragraph-400,
  .wui-font-paragraph-500,
  .wui-font-paragraph-600,
  .wui-font-paragraph-700 {
    font-size: var(--wui-font-size-paragraph);
    letter-spacing: var(--wui-letter-spacing-paragraph);
  }

  .wui-font-small-400,
  .wui-font-small-500,
  .wui-font-small-600 {
    font-size: var(--wui-font-size-small);
    letter-spacing: var(--wui-letter-spacing-small);
  }

  .wui-font-tiny-400,
  .wui-font-tiny-500,
  .wui-font-tiny-600 {
    font-size: var(--wui-font-size-tiny);
    letter-spacing: var(--wui-letter-spacing-tiny);
  }

  .wui-font-micro-700,
  .wui-font-micro-600 {
    font-size: var(--wui-font-size-micro);
    letter-spacing: var(--wui-letter-spacing-micro);
    text-transform: uppercase;
  }

  .wui-font-tiny-400,
  .wui-font-small-400,
  .wui-font-medium-400,
  .wui-font-paragraph-400 {
    font-weight: var(--wui-font-weight-light);
  }

  .wui-font-large-700,
  .wui-font-paragraph-700,
  .wui-font-micro-700,
  .wui-font-mini-700 {
    font-weight: var(--wui-font-weight-bold);
  }

  .wui-font-medium-600,
  .wui-font-medium-title-600,
  .wui-font-title-6-600,
  .wui-font-large-600,
  .wui-font-paragraph-600,
  .wui-font-small-600,
  .wui-font-tiny-600,
  .wui-font-micro-600 {
    font-weight: var(--wui-font-weight-medium);
  }

  :host([disabled]) {
    opacity: 0.4;
  }
`;var G=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let C=class extends O{constructor(){super(...arguments),this.variant="paragraph-500",this.color="fg-300",this.align="left",this.lineClamp=void 0}render(){const t={[`wui-font-${this.variant}`]:!0,[`wui-color-${this.color}`]:!0,[`wui-line-clamp-${this.lineClamp}`]:!!this.lineClamp};return this.style.cssText=`
      --local-align: ${this.align};
      --local-color: var(--wui-color-${this.color});
    `,E`<slot class=${Te(t)}></slot>`}};C.styles=[R,Re];G([h()],C.prototype,"variant",void 0);G([h()],C.prototype,"color",void 0);G([h()],C.prototype,"align",void 0);G([h()],C.prototype,"lineClamp",void 0);C=G([L("wui-text")],C);const Oe=T`
  :host {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    position: relative;
    overflow: hidden;
    background-color: var(--wui-color-gray-glass-020);
    border-radius: var(--local-border-radius);
    border: var(--local-border);
    box-sizing: content-box;
    width: var(--local-size);
    height: var(--local-size);
    min-height: var(--local-size);
    min-width: var(--local-size);
  }

  @supports (background: color-mix(in srgb, white 50%, black)) {
    :host {
      background-color: color-mix(in srgb, var(--local-bg-value) var(--local-bg-mix), transparent);
    }
  }
`;var m=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let f=class extends O{constructor(){super(...arguments),this.size="md",this.backgroundColor="accent-100",this.iconColor="accent-100",this.background="transparent",this.border=!1,this.borderColor="wui-color-bg-125",this.icon="copy"}render(){const t=this.iconSize||this.size,i=this.size==="lg",r=this.size==="xl",o=i?"12%":"16%",s=i?"xxs":r?"s":"3xl",n=this.background==="gray",a=this.background==="opaque",l=this.backgroundColor==="accent-100"&&a||this.backgroundColor==="success-100"&&a||this.backgroundColor==="error-100"&&a||this.backgroundColor==="inverse-100"&&a;let u=`var(--wui-color-${this.backgroundColor})`;return l?u=`var(--wui-icon-box-bg-${this.backgroundColor})`:n&&(u=`var(--wui-color-gray-${this.backgroundColor})`),this.style.cssText=`
       --local-bg-value: ${u};
       --local-bg-mix: ${l||n?"100%":o};
       --local-border-radius: var(--wui-border-radius-${s});
       --local-size: var(--wui-icon-box-size-${this.size});
       --local-border: ${this.borderColor==="wui-color-bg-125"?"2px":"1px"} solid ${this.border?`var(--${this.borderColor})`:"transparent"}
   `,E` <wui-icon color=${this.iconColor} size=${t} name=${this.icon}></wui-icon> `}};f.styles=[R,Mt,Oe];m([h()],f.prototype,"size",void 0);m([h()],f.prototype,"backgroundColor",void 0);m([h()],f.prototype,"iconColor",void 0);m([h()],f.prototype,"iconSize",void 0);m([h()],f.prototype,"background",void 0);m([h({type:Boolean})],f.prototype,"border",void 0);m([h()],f.prototype,"borderColor",void 0);m([h()],f.prototype,"icon",void 0);f=m([L("wui-icon-box")],f);const Le=T`
  :host {
    display: block;
    width: var(--local-width);
    height: var(--local-height);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center center;
    border-radius: inherit;
  }
`;var it=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let V=class extends O{constructor(){super(...arguments),this.src="./path/to/image.jpg",this.alt="Image",this.size=void 0}render(){return this.style.cssText=`
      --local-width: ${this.size?`var(--wui-icon-size-${this.size});`:"100%"};
      --local-height: ${this.size?`var(--wui-icon-size-${this.size});`:"100%"};
      `,E`<img src=${this.src} alt=${this.alt} @error=${this.handleImageError} />`}handleImageError(){this.dispatchEvent(new CustomEvent("onLoadError",{bubbles:!0,composed:!0}))}};V.styles=[R,xt,Le];it([h()],V.prototype,"src",void 0);it([h()],V.prototype,"alt",void 0);it([h()],V.prototype,"size",void 0);V=it([L("wui-image")],V);const De=T`
  :host {
    display: flex;
    justify-content: center;
    align-items: center;
    height: var(--wui-spacing-m);
    padding: 0 var(--wui-spacing-3xs) !important;
    border-radius: var(--wui-border-radius-5xs);
    transition:
      border-radius var(--wui-duration-lg) var(--wui-ease-out-power-1),
      background-color var(--wui-duration-lg) var(--wui-ease-out-power-1);
    will-change: border-radius, background-color;
  }

  :host > wui-text {
    transform: translateY(5%);
  }

  :host([data-variant='main']) {
    background-color: var(--wui-color-accent-glass-015);
    color: var(--wui-color-accent-100);
  }

  :host([data-variant='shade']) {
    background-color: var(--wui-color-gray-glass-010);
    color: var(--wui-color-fg-200);
  }

  :host([data-variant='success']) {
    background-color: var(--wui-icon-box-bg-success-100);
    color: var(--wui-color-success-100);
  }

  :host([data-variant='error']) {
    background-color: var(--wui-icon-box-bg-error-100);
    color: var(--wui-color-error-100);
  }

  :host([data-size='lg']) {
    padding: 11px 5px !important;
  }

  :host([data-size='lg']) > wui-text {
    transform: translateY(2%);
  }
`;var dt=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let N=class extends O{constructor(){super(...arguments),this.variant="main",this.size="lg"}render(){this.dataset.variant=this.variant,this.dataset.size=this.size;const t=this.size==="md"?"mini-700":"micro-700";return E`
      <wui-text data-variant=${this.variant} variant=${t} color="inherit">
        <slot></slot>
      </wui-text>
    `}};N.styles=[R,De];dt([h()],N.prototype,"variant",void 0);dt([h()],N.prototype,"size",void 0);N=dt([L("wui-tag")],N);const Ie=T`
  :host {
    display: flex;
  }

  :host([data-size='sm']) > svg {
    width: 12px;
    height: 12px;
  }

  :host([data-size='md']) > svg {
    width: 16px;
    height: 16px;
  }

  :host([data-size='lg']) > svg {
    width: 24px;
    height: 24px;
  }

  :host([data-size='xl']) > svg {
    width: 32px;
    height: 32px;
  }

  svg {
    animation: rotate 2s linear infinite;
  }

  circle {
    fill: none;
    stroke: var(--local-color);
    stroke-width: 4px;
    stroke-dasharray: 1, 124;
    stroke-dashoffset: 0;
    stroke-linecap: round;
    animation: dash 1.5s ease-in-out infinite;
  }

  :host([data-size='md']) > svg > circle {
    stroke-width: 6px;
  }

  :host([data-size='sm']) > svg > circle {
    stroke-width: 8px;
  }

  @keyframes rotate {
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes dash {
    0% {
      stroke-dasharray: 1, 124;
      stroke-dashoffset: 0;
    }

    50% {
      stroke-dasharray: 90, 124;
      stroke-dashoffset: -35;
    }

    100% {
      stroke-dashoffset: -125;
    }
  }
`;var pt=function(e,t,i,r){var o=arguments.length,s=o<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,i):r,n;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")s=Reflect.decorate(e,t,i,r);else for(var a=e.length-1;a>=0;a--)(n=e[a])&&(s=(o<3?n(s):o>3?n(t,i,s):n(t,i))||s);return o>3&&s&&Object.defineProperty(t,i,s),s};let W=class extends O{constructor(){super(...arguments),this.color="accent-100",this.size="lg"}render(){return this.style.cssText=`--local-color: ${this.color==="inherit"?"inherit":`var(--wui-color-${this.color})`}`,this.dataset.size=this.size,E`<svg viewBox="25 25 50 50">
      <circle r="20" cy="50" cx="50"></circle>
    </svg>`}};W.styles=[R,Ie];pt([h()],W.prototype,"color",void 0);pt([h()],W.prototype,"size",void 0);W=pt([L("wui-loading-spinner")],W);export{$ as U,de as a,Ue as b,L as c,Te as d,It as e,$e as f,Z as i,h as n,We as o,Be as r,He as x};
