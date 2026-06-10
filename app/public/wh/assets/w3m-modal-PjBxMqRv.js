import{c as u,n as d,b as A,r as w,i as T,x as a,o as Y,U as ve,a as fe}from"./index-DJEDKil_.js";import{w as ge,s as be,t as ye,v as xe,M as v,y as oe,R as l,i as I,r as P,a as _,x as f,z,e as ae,o as re,j as m,f as V,k as Ce,B as C,c as Q,O,C as G,D as Z,l as $,A as U,T as ke,F as Se,b as Ne,h as We}from"./core-CiTgkwkF.js";import"../main.mjs";import"./index.es-BctUhcbn.js";import"./http-D4bz-t0I.js";import"./big-DS5bVq7O.js";const p=be({message:"",open:!1,triggerRect:{width:0,height:0,top:0,left:0},variant:"shade"}),$e={state:p,subscribe(n){return xe(p,()=>n(p))},subscribeKey(n,e){return ye(p,n,e)},showTooltip({message:n,triggerRect:e,variant:t}){p.open=!0,p.message=n,p.triggerRect=e,p.variant=t},hide(){p.open=!1,p.message="",p.triggerRect={width:0,height:0,top:0,left:0}}},R=ge($e),ne={isUnsupportedChainView(){return l.state.view==="UnsupportedChain"||l.state.view==="SwitchNetwork"&&l.state.history.includes("UnsupportedChain")},async safeClose(){if(this.isUnsupportedChainView()){v.shake();return}if(await oe.isSIWXCloseDisabled()){v.shake();return}v.close()}},Re=I`
  :host {
    display: block;
    border-radius: clamp(0px, var(--wui-border-radius-l), 44px);
    box-shadow: 0 0 0 1px var(--wui-color-gray-glass-005);
    background-color: var(--wui-color-modal-bg);
    overflow: hidden;
  }

  :host([data-embedded='true']) {
    box-shadow:
      0 0 0 1px var(--wui-color-gray-glass-005),
      0px 4px 12px 4px var(--w3m-card-embedded-shadow-color);
  }
`;var Ae=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let q=class extends _{render(){return f`<slot></slot>`}};q.styles=[P,Re];q=Ae([u("wui-card")],q);const Te=I`
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--wui-spacing-s);
    border-radius: var(--wui-border-radius-s);
    border: 1px solid var(--wui-color-dark-glass-100);
    box-sizing: border-box;
    background-color: var(--wui-color-bg-325);
    box-shadow: 0px 0px 16px 0px rgba(0, 0, 0, 0.25);
  }

  wui-flex {
    width: 100%;
  }

  wui-text {
    word-break: break-word;
    flex: 1;
  }

  .close {
    cursor: pointer;
  }

  .icon-box {
    height: 40px;
    width: 40px;
    border-radius: var(--wui-border-radius-3xs);
    background-color: var(--local-icon-bg-value);
  }
`;var B=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let k=class extends _{constructor(){super(...arguments),this.message="",this.backgroundColor="accent-100",this.iconColor="accent-100",this.icon="info"}render(){return this.style.cssText=`
      --local-icon-bg-value: var(--wui-color-${this.backgroundColor});
   `,f`
      <wui-flex flexDirection="row" justifyContent="space-between" alignItems="center">
        <wui-flex columnGap="xs" flexDirection="row" alignItems="center">
          <wui-flex
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            class="icon-box"
          >
            <wui-icon color=${this.iconColor} size="md" name=${this.icon}></wui-icon>
          </wui-flex>
          <wui-text variant="small-500" color="bg-350" data-testid="wui-alertbar-text"
            >${this.message}</wui-text
          >
        </wui-flex>
        <wui-icon
          class="close"
          color="bg-350"
          size="sm"
          name="close"
          @click=${this.onClose}
        ></wui-icon>
      </wui-flex>
    `}onClose(){z.close()}};k.styles=[P,Te];B([d()],k.prototype,"message",void 0);B([d()],k.prototype,"backgroundColor",void 0);B([d()],k.prototype,"iconColor",void 0);B([d()],k.prototype,"icon",void 0);k=B([u("wui-alertbar")],k);const Oe=A`
  :host {
    display: block;
    position: absolute;
    top: var(--wui-spacing-s);
    left: var(--wui-spacing-l);
    right: var(--wui-spacing-l);
    opacity: 0;
    pointer-events: none;
  }
`;var se=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};const Ee={info:{backgroundColor:"fg-350",iconColor:"fg-325",icon:"info"},success:{backgroundColor:"success-glass-reown-020",iconColor:"success-125",icon:"checkmark"},warning:{backgroundColor:"warning-glass-reown-020",iconColor:"warning-100",icon:"warningCircle"},error:{backgroundColor:"error-glass-reown-020",iconColor:"error-125",icon:"exclamationTriangle"}};let H=class extends T{constructor(){super(),this.unsubscribe=[],this.open=z.state.open,this.onOpen(!0),this.unsubscribe.push(z.subscribeKey("open",e=>{this.open=e,this.onOpen(!1)}))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){const{message:e,variant:t}=z.state,o=Ee[t];return a`
      <wui-alertbar
        message=${e}
        backgroundColor=${o?.backgroundColor}
        iconColor=${o?.iconColor}
        icon=${o?.icon}
      ></wui-alertbar>
    `}onOpen(e){this.open?(this.animate([{opacity:0,transform:"scale(0.85)"},{opacity:1,transform:"scale(1)"}],{duration:150,fill:"forwards",easing:"ease"}),this.style.cssText="pointer-events: auto"):e||(this.animate([{opacity:1,transform:"scale(1)"},{opacity:0,transform:"scale(0.85)"}],{duration:150,fill:"forwards",easing:"ease"}),this.style.cssText="pointer-events: none")}};H.styles=Oe;se([w()],H.prototype,"open",void 0);H=se([u("w3m-alertbar")],H);const Ie=I`
  button {
    border-radius: var(--local-border-radius);
    color: var(--wui-color-fg-100);
    padding: var(--local-padding);
  }

  @media (max-width: 700px) {
    button {
      padding: var(--wui-spacing-s);
    }
  }

  button > wui-icon {
    pointer-events: none;
  }

  button:disabled > wui-icon {
    color: var(--wui-color-bg-300) !important;
  }

  button:disabled {
    background-color: transparent;
  }
`;var D=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let S=class extends _{constructor(){super(...arguments),this.size="md",this.disabled=!1,this.icon="copy",this.iconColor="inherit"}render(){const e=this.size==="lg"?"--wui-border-radius-xs":"--wui-border-radius-xxs",t=this.size==="lg"?"--wui-spacing-1xs":"--wui-spacing-2xs";return this.style.cssText=`
    --local-border-radius: var(${e});
    --local-padding: var(${t});
`,f`
      <button ?disabled=${this.disabled}>
        <wui-icon color=${this.iconColor} size=${this.size} name=${this.icon}></wui-icon>
      </button>
    `}};S.styles=[P,ae,re,Ie];D([d()],S.prototype,"size",void 0);D([d({type:Boolean})],S.prototype,"disabled",void 0);D([d()],S.prototype,"icon",void 0);D([d()],S.prototype,"iconColor",void 0);S=D([u("wui-icon-link")],S);const Pe=I`
  button {
    display: block;
    display: flex;
    align-items: center;
    padding: var(--wui-spacing-xxs);
    gap: var(--wui-spacing-xxs);
    transition: all var(--wui-ease-out-power-1) var(--wui-duration-md);
    border-radius: var(--wui-border-radius-xxs);
  }

  wui-image {
    border-radius: 100%;
    width: var(--wui-spacing-xl);
    height: var(--wui-spacing-xl);
  }

  wui-icon-box {
    width: var(--wui-spacing-xl);
    height: var(--wui-spacing-xl);
  }

  button:hover {
    background-color: var(--wui-color-gray-glass-002);
  }

  button:active {
    background-color: var(--wui-color-gray-glass-005);
  }
`;var ce=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let K=class extends _{constructor(){super(...arguments),this.imageSrc=""}render(){return f`<button>
      ${this.imageTemplate()}
      <wui-icon size="xs" color="fg-200" name="chevronBottom"></wui-icon>
    </button>`}imageTemplate(){return this.imageSrc?f`<wui-image src=${this.imageSrc} alt="select visual"></wui-image>`:f`<wui-icon-box
      size="xxs"
      iconColor="fg-200"
      backgroundColor="fg-100"
      background="opaque"
      icon="networkPlaceholder"
    ></wui-icon-box>`}};K.styles=[P,ae,re,Pe];ce([d()],K.prototype,"imageSrc",void 0);K=ce([u("wui-select")],K);const _e=A`
  :host {
    height: 64px;
  }

  wui-text {
    text-transform: capitalize;
  }

  wui-flex.w3m-header-title {
    transform: translateY(0);
    opacity: 1;
  }

  wui-flex.w3m-header-title[view-direction='prev'] {
    animation:
      slide-down-out 120ms forwards var(--wui-ease-out-power-2),
      slide-down-in 120ms forwards var(--wui-ease-out-power-2);
    animation-delay: 0ms, 200ms;
  }

  wui-flex.w3m-header-title[view-direction='next'] {
    animation:
      slide-up-out 120ms forwards var(--wui-ease-out-power-2),
      slide-up-in 120ms forwards var(--wui-ease-out-power-2);
    animation-delay: 0ms, 200ms;
  }

  wui-icon-link[data-hidden='true'] {
    opacity: 0 !important;
    pointer-events: none;
  }

  @keyframes slide-up-out {
    from {
      transform: translateY(0px);
      opacity: 1;
    }
    to {
      transform: translateY(3px);
      opacity: 0;
    }
  }

  @keyframes slide-up-in {
    from {
      transform: translateY(-3px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @keyframes slide-down-out {
    from {
      transform: translateY(0px);
      opacity: 1;
    }
    to {
      transform: translateY(-3px);
      opacity: 0;
    }
  }

  @keyframes slide-down-in {
    from {
      transform: translateY(3px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }
`;var b=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};const Be=["SmartSessionList"];function X(){const n=l.state.data?.connector?.name,e=l.state.data?.wallet?.name,t=l.state.data?.network?.name,o=e??n,r=G.getConnectors();return{Connect:`Connect ${r.length===1&&r[0]?.id==="w3m-email"?"Email":""} Wallet`,Create:"Create Wallet",ChooseAccountName:void 0,Account:void 0,AccountSettings:void 0,AllWallets:"All Wallets",ApproveTransaction:"Approve Transaction",BuyInProgress:"Buy",ConnectingExternal:o??"Connect Wallet",ConnectingWalletConnect:o??"WalletConnect",ConnectingWalletConnectBasic:"WalletConnect",ConnectingSiwe:"Sign In",Convert:"Convert",ConvertSelectToken:"Select token",ConvertPreview:"Preview convert",Downloads:o?`Get ${o}`:"Downloads",EmailLogin:"Email Login",EmailVerifyOtp:"Confirm Email",EmailVerifyDevice:"Register Device",GetWallet:"Get a wallet",Networks:"Choose Network",OnRampProviders:"Choose Provider",OnRampActivity:"Activity",OnRampTokenSelect:"Select Token",OnRampFiatSelect:"Select Currency",Pay:"How you pay",Profile:void 0,SwitchNetwork:t??"Switch Network",SwitchAddress:"Switch Address",Transactions:"Activity",UnsupportedChain:"Switch Network",UpgradeEmailWallet:"Upgrade your Wallet",UpdateEmailWallet:"Edit Email",UpdateEmailPrimaryOtp:"Confirm Current Email",UpdateEmailSecondaryOtp:"Confirm New Email",WhatIsABuy:"What is Buy?",RegisterAccountName:"Choose name",RegisterAccountNameSuccess:"",WalletReceive:"Receive",WalletCompatibleNetworks:"Compatible Networks",Swap:"Swap",SwapSelectToken:"Select token",SwapPreview:"Preview swap",WalletSend:"Send",WalletSendPreview:"Review send",WalletSendSelectToken:"Select Token",WhatIsANetwork:"What is a network?",WhatIsAWallet:"What is a wallet?",ConnectWallets:"Connect wallet",ConnectSocials:"All socials",ConnectingSocial:Z.state.socialProvider?Z.state.socialProvider:"Connect Social",ConnectingMultiChain:"Select chain",ConnectingFarcaster:"Farcaster",SwitchActiveChain:"Switch chain",SmartSessionCreated:void 0,SmartSessionList:"Smart Sessions",SIWXSignMessage:"Sign In",PayLoading:"Payment in progress"}}let h=class extends T{constructor(){super(),this.unsubscribe=[],this.heading=X()[l.state.view],this.network=m.state.activeCaipNetwork,this.networkImage=V.getNetworkImage(this.network),this.showBack=!1,this.prevHistoryLength=1,this.view=l.state.view,this.viewDirection="",this.headerText=X()[l.state.view],this.unsubscribe.push(Ce.subscribeNetworkImages(()=>{this.networkImage=V.getNetworkImage(this.network)}),l.subscribeKey("view",e=>{setTimeout(()=>{this.view=e,this.headerText=X()[e]},C.ANIMATION_DURATIONS.HeaderText),this.onViewChange(),this.onHistoryChange()}),m.subscribeKey("activeCaipNetwork",e=>{this.network=e,this.networkImage=V.getNetworkImage(this.network)}))}disconnectCallback(){this.unsubscribe.forEach(e=>e())}render(){return a`
      <wui-flex .padding=${this.getPadding()} justifyContent="space-between" alignItems="center">
        ${this.leftHeaderTemplate()} ${this.titleTemplate()} ${this.rightHeaderTemplate()}
      </wui-flex>
    `}onWalletHelp(){Q.sendEvent({type:"track",event:"CLICK_WALLET_HELP"}),l.push("WhatIsAWallet")}async onClose(){await ne.safeClose()}rightHeaderTemplate(){const e=O?.state?.features?.smartSessions;return l.state.view!=="Account"||!e?this.closeButtonTemplate():a`<wui-flex>
      <wui-icon-link
        icon="clock"
        @click=${()=>l.push("SmartSessionList")}
        data-testid="w3m-header-smart-sessions"
      ></wui-icon-link>
      ${this.closeButtonTemplate()}
    </wui-flex> `}closeButtonTemplate(){return a`
      <wui-icon-link
        icon="close"
        @click=${this.onClose.bind(this)}
        data-testid="w3m-header-close"
      ></wui-icon-link>
    `}titleTemplate(){const e=Be.includes(this.view);return a`
      <wui-flex
        view-direction="${this.viewDirection}"
        class="w3m-header-title"
        alignItems="center"
        gap="xs"
      >
        <wui-text variant="paragraph-700" color="fg-100" data-testid="w3m-header-text"
          >${this.headerText}</wui-text
        >
        ${e?a`<wui-tag variant="main">Beta</wui-tag>`:null}
      </wui-flex>
    `}leftHeaderTemplate(){const{view:e}=l.state,t=e==="Connect",o=O.state.enableEmbedded,r=e==="ApproveTransaction",i=e==="ConnectingSiwe",s=e==="Account",c=O.state.enableNetworkSwitch,J=r||i||t&&o;return s&&c?a`<wui-select
        id="dynamic"
        data-testid="w3m-account-select-network"
        active-network=${Y(this.network?.name)}
        @click=${this.onNetworks.bind(this)}
        imageSrc=${Y(this.networkImage)}
      ></wui-select>`:this.showBack&&!J?a`<wui-icon-link
        data-testid="header-back"
        id="dynamic"
        icon="chevronLeft"
        @click=${this.onGoBack.bind(this)}
      ></wui-icon-link>`:a`<wui-icon-link
      data-hidden=${!t}
      id="dynamic"
      icon="helpCircle"
      @click=${this.onWalletHelp.bind(this)}
    ></wui-icon-link>`}onNetworks(){this.isAllowedNetworkSwitch()&&(Q.sendEvent({type:"track",event:"CLICK_NETWORKS"}),l.push("Networks"))}isAllowedNetworkSwitch(){const e=m.getAllRequestedCaipNetworks(),t=e?e.length>1:!1,o=e?.find(({id:r})=>r===this.network?.id);return t||!o}getPadding(){return this.heading?["l","2l","l","2l"]:["0","2l","0","2l"]}onViewChange(){const{history:e}=l.state;let t=C.VIEW_DIRECTION.Next;e.length<this.prevHistoryLength&&(t=C.VIEW_DIRECTION.Prev),this.prevHistoryLength=e.length,this.viewDirection=t}async onHistoryChange(){const{history:e}=l.state,t=this.shadowRoot?.querySelector("#dynamic");e.length>1&&!this.showBack&&t?(await t.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.showBack=!0,t.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"})):e.length<=1&&this.showBack&&t&&(await t.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.showBack=!1,t.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"}))}onGoBack(){l.goBack()}};h.styles=_e;b([w()],h.prototype,"heading",void 0);b([w()],h.prototype,"network",void 0);b([w()],h.prototype,"networkImage",void 0);b([w()],h.prototype,"showBack",void 0);b([w()],h.prototype,"prevHistoryLength",void 0);b([w()],h.prototype,"view",void 0);b([w()],h.prototype,"viewDirection",void 0);b([w()],h.prototype,"headerText",void 0);h=b([u("w3m-header")],h);const De=I`
  :host {
    display: flex;
    column-gap: var(--wui-spacing-s);
    align-items: center;
    padding: var(--wui-spacing-xs) var(--wui-spacing-m) var(--wui-spacing-xs) var(--wui-spacing-xs);
    border-radius: var(--wui-border-radius-s);
    border: 1px solid var(--wui-color-gray-glass-005);
    box-sizing: border-box;
    background-color: var(--wui-color-bg-175);
    box-shadow:
      0px 14px 64px -4px rgba(0, 0, 0, 0.15),
      0px 8px 22px -6px rgba(0, 0, 0, 0.15);

    max-width: 300px;
  }

  :host wui-loading-spinner {
    margin-left: var(--wui-spacing-3xs);
  }
`;var W=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let g=class extends _{constructor(){super(...arguments),this.backgroundColor="accent-100",this.iconColor="accent-100",this.icon="checkmark",this.message="",this.loading=!1,this.iconType="default"}render(){return f`
      ${this.templateIcon()}
      <wui-text variant="paragraph-500" color="fg-100" data-testid="wui-snackbar-message"
        >${this.message}</wui-text
      >
    `}templateIcon(){return this.loading?f`<wui-loading-spinner size="md" color="accent-100"></wui-loading-spinner>`:this.iconType==="default"?f`<wui-icon size="xl" color=${this.iconColor} name=${this.icon}></wui-icon>`:f`<wui-icon-box
      size="sm"
      iconSize="xs"
      iconColor=${this.iconColor}
      backgroundColor=${this.backgroundColor}
      icon=${this.icon}
      background="opaque"
    ></wui-icon-box>`}};g.styles=[P,De];W([d()],g.prototype,"backgroundColor",void 0);W([d()],g.prototype,"iconColor",void 0);W([d()],g.prototype,"icon",void 0);W([d()],g.prototype,"message",void 0);W([d()],g.prototype,"loading",void 0);W([d()],g.prototype,"iconType",void 0);g=W([u("wui-snackbar")],g);const je=A`
  :host {
    display: block;
    position: absolute;
    opacity: 0;
    pointer-events: none;
    top: 11px;
    left: 50%;
    width: max-content;
  }
`;var le=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};const Le={loading:void 0,success:{backgroundColor:"success-100",iconColor:"success-100",icon:"checkmark"},error:{backgroundColor:"error-100",iconColor:"error-100",icon:"close"}};let M=class extends T{constructor(){super(),this.unsubscribe=[],this.timeout=void 0,this.open=$.state.open,this.unsubscribe.push($.subscribeKey("open",e=>{this.open=e,this.onOpen()}))}disconnectedCallback(){clearTimeout(this.timeout),this.unsubscribe.forEach(e=>e())}render(){const{message:e,variant:t,svg:o}=$.state,r=Le[t],{icon:i,iconColor:s}=o??r??{};return a`
      <wui-snackbar
        message=${e}
        backgroundColor=${r?.backgroundColor}
        iconColor=${s}
        icon=${i}
        .loading=${t==="loading"}
      ></wui-snackbar>
    `}onOpen(){clearTimeout(this.timeout),this.open?(this.animate([{opacity:0,transform:"translateX(-50%) scale(0.85)"},{opacity:1,transform:"translateX(-50%) scale(1)"}],{duration:150,fill:"forwards",easing:"ease"}),this.timeout&&clearTimeout(this.timeout),$.state.autoClose&&(this.timeout=setTimeout(()=>$.hide(),2500))):this.animate([{opacity:1,transform:"translateX(-50%) scale(1)"},{opacity:0,transform:"translateX(-50%) scale(0.85)"}],{duration:150,fill:"forwards",easing:"ease"})}};M.styles=je;le([w()],M.prototype,"open",void 0);M=le([u("w3m-snackbar")],M);const Ue=A`
  :host {
    pointer-events: none;
  }

  :host > wui-flex {
    display: var(--w3m-tooltip-display);
    opacity: var(--w3m-tooltip-opacity);
    padding: 9px var(--wui-spacing-s) 10px var(--wui-spacing-s);
    border-radius: var(--wui-border-radius-xxs);
    color: var(--wui-color-bg-100);
    position: fixed;
    top: var(--w3m-tooltip-top);
    left: var(--w3m-tooltip-left);
    transform: translate(calc(-50% + var(--w3m-tooltip-parent-width)), calc(-100% - 8px));
    max-width: calc(var(--w3m-modal-width) - var(--wui-spacing-xl));
    transition: opacity 0.2s var(--wui-ease-out-power-2);
    will-change: opacity;
  }

  :host([data-variant='shade']) > wui-flex {
    background-color: var(--wui-color-bg-150);
    border: 1px solid var(--wui-color-gray-glass-005);
  }

  :host([data-variant='shade']) > wui-flex > wui-text {
    color: var(--wui-color-fg-150);
  }

  :host([data-variant='fill']) > wui-flex {
    background-color: var(--wui-color-fg-100);
    border: none;
  }

  wui-icon {
    position: absolute;
    width: 12px !important;
    height: 4px !important;
    color: var(--wui-color-bg-150);
  }

  wui-icon[data-placement='top'] {
    bottom: 0px;
    left: 50%;
    transform: translate(-50%, 95%);
  }

  wui-icon[data-placement='bottom'] {
    top: 0;
    left: 50%;
    transform: translate(-50%, -95%) rotate(180deg);
  }

  wui-icon[data-placement='right'] {
    top: 50%;
    left: 0;
    transform: translate(-65%, -50%) rotate(90deg);
  }

  wui-icon[data-placement='left'] {
    top: 50%;
    right: 0%;
    transform: translate(65%, -50%) rotate(270deg);
  }
`;var j=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let N=class extends T{constructor(){super(),this.unsubscribe=[],this.open=R.state.open,this.message=R.state.message,this.triggerRect=R.state.triggerRect,this.variant=R.state.variant,this.unsubscribe.push(R.subscribe(e=>{this.open=e.open,this.message=e.message,this.triggerRect=e.triggerRect,this.variant=e.variant}))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){this.dataset.variant=this.variant;const e=this.triggerRect.top,t=this.triggerRect.left;return this.style.cssText=`
    --w3m-tooltip-top: ${e}px;
    --w3m-tooltip-left: ${t}px;
    --w3m-tooltip-parent-width: ${this.triggerRect.width/2}px;
    --w3m-tooltip-display: ${this.open?"flex":"none"};
    --w3m-tooltip-opacity: ${this.open?1:0};
    `,a`<wui-flex>
      <wui-icon data-placement="top" color="fg-100" size="inherit" name="cursor"></wui-icon>
      <wui-text color="inherit" variant="small-500">${this.message}</wui-text>
    </wui-flex>`}};N.styles=[Ue];j([w()],N.prototype,"open",void 0);j([w()],N.prototype,"message",void 0);j([w()],N.prototype,"triggerRect",void 0);j([w()],N.prototype,"variant",void 0);N=j([u("w3m-tooltip"),u("w3m-tooltip")],N);const ze=A`
  :host {
    --prev-height: 0px;
    --new-height: 0px;
    display: block;
  }

  div.w3m-router-container {
    transform: translateY(0);
    opacity: 1;
  }

  div.w3m-router-container[view-direction='prev'] {
    animation:
      slide-left-out 150ms forwards ease,
      slide-left-in 150ms forwards ease;
    animation-delay: 0ms, 200ms;
  }

  div.w3m-router-container[view-direction='next'] {
    animation:
      slide-right-out 150ms forwards ease,
      slide-right-in 150ms forwards ease;
    animation-delay: 0ms, 200ms;
  }

  @keyframes slide-left-out {
    from {
      transform: translateX(0px);
      opacity: 1;
    }
    to {
      transform: translateX(10px);
      opacity: 0;
    }
  }

  @keyframes slide-left-in {
    from {
      transform: translateX(-10px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes slide-right-out {
    from {
      transform: translateX(0px);
      opacity: 1;
    }
    to {
      transform: translateX(-10px);
      opacity: 0;
    }
  }

  @keyframes slide-right-in {
    from {
      transform: translateX(10px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
`;var F=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};let E=class extends T{constructor(){super(),this.resizeObserver=void 0,this.prevHeight="0px",this.prevHistoryLength=1,this.unsubscribe=[],this.view=l.state.view,this.viewDirection="",this.unsubscribe.push(l.subscribeKey("view",e=>this.onViewChange(e)))}firstUpdated(){this.resizeObserver=new ResizeObserver(([e])=>{const t=`${e?.contentRect.height}px`;this.prevHeight!=="0px"&&(this.style.setProperty("--prev-height",this.prevHeight),this.style.setProperty("--new-height",t),this.style.animation="w3m-view-height 150ms forwards ease",this.style.height="auto"),setTimeout(()=>{this.prevHeight=t,this.style.animation="unset"},C.ANIMATION_DURATIONS.ModalHeight)}),this.resizeObserver?.observe(this.getWrapper())}disconnectedCallback(){this.resizeObserver?.unobserve(this.getWrapper()),this.unsubscribe.forEach(e=>e())}render(){return a`<div class="w3m-router-container" view-direction="${this.viewDirection}">
      ${this.viewTemplate()}
    </div>`}viewTemplate(){switch(this.view){case"AccountSettings":return a`<w3m-account-settings-view></w3m-account-settings-view>`;case"Account":return a`<w3m-account-view></w3m-account-view>`;case"AllWallets":return a`<w3m-all-wallets-view></w3m-all-wallets-view>`;case"ApproveTransaction":return a`<w3m-approve-transaction-view></w3m-approve-transaction-view>`;case"BuyInProgress":return a`<w3m-buy-in-progress-view></w3m-buy-in-progress-view>`;case"ChooseAccountName":return a`<w3m-choose-account-name-view></w3m-choose-account-name-view>`;case"Connect":return a`<w3m-connect-view></w3m-connect-view>`;case"Create":return a`<w3m-connect-view walletGuide="explore"></w3m-connect-view>`;case"ConnectingWalletConnect":return a`<w3m-connecting-wc-view></w3m-connecting-wc-view>`;case"ConnectingWalletConnectBasic":return a`<w3m-connecting-wc-basic-view></w3m-connecting-wc-basic-view>`;case"ConnectingExternal":return a`<w3m-connecting-external-view></w3m-connecting-external-view>`;case"ConnectingSiwe":return a`<w3m-connecting-siwe-view></w3m-connecting-siwe-view>`;case"ConnectWallets":return a`<w3m-connect-wallets-view></w3m-connect-wallets-view>`;case"ConnectSocials":return a`<w3m-connect-socials-view></w3m-connect-socials-view>`;case"ConnectingSocial":return a`<w3m-connecting-social-view></w3m-connecting-social-view>`;case"Downloads":return a`<w3m-downloads-view></w3m-downloads-view>`;case"EmailLogin":return a`<w3m-email-login-view></w3m-email-login-view>`;case"EmailVerifyOtp":return a`<w3m-email-verify-otp-view></w3m-email-verify-otp-view>`;case"EmailVerifyDevice":return a`<w3m-email-verify-device-view></w3m-email-verify-device-view>`;case"GetWallet":return a`<w3m-get-wallet-view></w3m-get-wallet-view>`;case"Networks":return a`<w3m-networks-view></w3m-networks-view>`;case"SwitchNetwork":return a`<w3m-network-switch-view></w3m-network-switch-view>`;case"Profile":return a`<w3m-profile-view></w3m-profile-view>`;case"SwitchAddress":return a`<w3m-switch-address-view></w3m-switch-address-view>`;case"Transactions":return a`<w3m-transactions-view></w3m-transactions-view>`;case"OnRampProviders":return a`<w3m-onramp-providers-view></w3m-onramp-providers-view>`;case"OnRampActivity":return a`<w3m-onramp-activity-view></w3m-onramp-activity-view>`;case"OnRampTokenSelect":return a`<w3m-onramp-token-select-view></w3m-onramp-token-select-view>`;case"OnRampFiatSelect":return a`<w3m-onramp-fiat-select-view></w3m-onramp-fiat-select-view>`;case"UpgradeEmailWallet":return a`<w3m-upgrade-wallet-view></w3m-upgrade-wallet-view>`;case"UpdateEmailWallet":return a`<w3m-update-email-wallet-view></w3m-update-email-wallet-view>`;case"UpdateEmailPrimaryOtp":return a`<w3m-update-email-primary-otp-view></w3m-update-email-primary-otp-view>`;case"UpdateEmailSecondaryOtp":return a`<w3m-update-email-secondary-otp-view></w3m-update-email-secondary-otp-view>`;case"UnsupportedChain":return a`<w3m-unsupported-chain-view></w3m-unsupported-chain-view>`;case"Swap":return a`<w3m-swap-view></w3m-swap-view>`;case"SwapSelectToken":return a`<w3m-swap-select-token-view></w3m-swap-select-token-view>`;case"SwapPreview":return a`<w3m-swap-preview-view></w3m-swap-preview-view>`;case"WalletSend":return a`<w3m-wallet-send-view></w3m-wallet-send-view>`;case"WalletSendSelectToken":return a`<w3m-wallet-send-select-token-view></w3m-wallet-send-select-token-view>`;case"WalletSendPreview":return a`<w3m-wallet-send-preview-view></w3m-wallet-send-preview-view>`;case"WhatIsABuy":return a`<w3m-what-is-a-buy-view></w3m-what-is-a-buy-view>`;case"WalletReceive":return a`<w3m-wallet-receive-view></w3m-wallet-receive-view>`;case"WalletCompatibleNetworks":return a`<w3m-wallet-compatible-networks-view></w3m-wallet-compatible-networks-view>`;case"WhatIsAWallet":return a`<w3m-what-is-a-wallet-view></w3m-what-is-a-wallet-view>`;case"ConnectingMultiChain":return a`<w3m-connecting-multi-chain-view></w3m-connecting-multi-chain-view>`;case"WhatIsANetwork":return a`<w3m-what-is-a-network-view></w3m-what-is-a-network-view>`;case"ConnectingFarcaster":return a`<w3m-connecting-farcaster-view></w3m-connecting-farcaster-view>`;case"SwitchActiveChain":return a`<w3m-switch-active-chain-view></w3m-switch-active-chain-view>`;case"RegisterAccountName":return a`<w3m-register-account-name-view></w3m-register-account-name-view>`;case"RegisterAccountNameSuccess":return a`<w3m-register-account-name-success-view></w3m-register-account-name-success-view>`;case"SmartSessionCreated":return a`<w3m-smart-session-created-view></w3m-smart-session-created-view>`;case"SmartSessionList":return a`<w3m-smart-session-list-view></w3m-smart-session-list-view>`;case"SIWXSignMessage":return a`<w3m-siwx-sign-message-view></w3m-siwx-sign-message-view>`;case"Pay":return a`<w3m-pay-view></w3m-pay-view>`;case"PayLoading":return a`<w3m-pay-loading-view></w3m-pay-loading-view>`;default:return a`<w3m-connect-view></w3m-connect-view>`}}onViewChange(e){R.hide();let t=C.VIEW_DIRECTION.Next;const{history:o}=l.state;o.length<this.prevHistoryLength&&(t=C.VIEW_DIRECTION.Prev),this.prevHistoryLength=o.length,this.viewDirection=t,setTimeout(()=>{this.view=e},C.ANIMATION_DURATIONS.ViewTransition)}getWrapper(){return this.shadowRoot?.querySelector("div")}};E.styles=ze;F([w()],E.prototype,"view",void 0);F([w()],E.prototype,"viewDirection",void 0);E=F([u("w3m-router")],E);const He=A`
  :host {
    z-index: var(--w3m-z-index);
    display: block;
    backface-visibility: hidden;
    will-change: opacity;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    opacity: 0;
    background-color: var(--wui-cover);
    transition: opacity 0.2s var(--wui-ease-out-power-2);
    will-change: opacity;
  }

  :host(.open) {
    opacity: 1;
  }

  :host(.appkit-modal) {
    position: relative;
    pointer-events: unset;
    background: none;
    width: 100%;
    opacity: 1;
  }

  wui-card {
    max-width: var(--w3m-modal-width);
    width: 100%;
    position: relative;
    animation: zoom-in 0.2s var(--wui-ease-out-power-2);
    animation-fill-mode: backwards;
    outline: none;
    transition:
      border-radius var(--wui-duration-lg) var(--wui-ease-out-power-1),
      background-color var(--wui-duration-lg) var(--wui-ease-out-power-1);
    will-change: border-radius, background-color;
  }

  :host(.appkit-modal) wui-card {
    max-width: 400px;
  }

  wui-card[shake='true'] {
    animation:
      zoom-in 0.2s var(--wui-ease-out-power-2),
      w3m-shake 0.5s var(--wui-ease-out-power-2);
  }

  wui-flex {
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  @media (max-height: 700px) and (min-width: 431px) {
    wui-flex {
      align-items: flex-start;
    }

    wui-card {
      margin: var(--wui-spacing-xxl) 0px;
    }
  }

  @media (max-width: 430px) {
    wui-flex {
      align-items: flex-end;
    }

    wui-card {
      max-width: 100%;
      border-bottom-left-radius: var(--local-border-bottom-mobile-radius);
      border-bottom-right-radius: var(--local-border-bottom-mobile-radius);
      border-bottom: none;
      animation: slide-in 0.2s var(--wui-ease-out-power-2);
    }

    wui-card[shake='true'] {
      animation:
        slide-in 0.2s var(--wui-ease-out-power-2),
        w3m-shake 0.5s var(--wui-ease-out-power-2);
    }
  }

  @keyframes zoom-in {
    0% {
      transform: scale(0.95) translateY(0);
    }
    100% {
      transform: scale(1) translateY(0);
    }
  }

  @keyframes slide-in {
    0% {
      transform: scale(1) translateY(50px);
    }
    100% {
      transform: scale(1) translateY(0);
    }
  }

  @keyframes w3m-shake {
    0% {
      transform: scale(1) rotate(0deg);
    }
    20% {
      transform: scale(1) rotate(-1deg);
    }
    40% {
      transform: scale(1) rotate(1.5deg);
    }
    60% {
      transform: scale(1) rotate(-1.5deg);
    }
    80% {
      transform: scale(1) rotate(1deg);
    }
    100% {
      transform: scale(1) rotate(0deg);
    }
  }

  @keyframes w3m-view-height {
    from {
      height: var(--prev-height);
    }
    to {
      height: var(--new-height);
    }
  }
`;var x=function(n,e,t,o){var r=arguments.length,i=r<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(r<3?s(i):r>3?s(e,t,i):s(e,t))||i);return r>3&&i&&Object.defineProperty(e,t,i),i};const ee="scroll-lock";class y extends T{constructor(){super(),this.unsubscribe=[],this.abortController=void 0,this.hasPrefetched=!1,this.enableEmbedded=O.state.enableEmbedded,this.open=v.state.open,this.caipAddress=m.state.activeCaipAddress,this.caipNetwork=m.state.activeCaipNetwork,this.shake=v.state.shake,this.filterByNamespace=G.state.filterByNamespace,this.initializeTheming(),U.prefetchAnalyticsConfig(),this.unsubscribe.push(v.subscribeKey("open",e=>e?this.onOpen():this.onClose()),v.subscribeKey("shake",e=>this.shake=e),m.subscribeKey("activeCaipNetwork",e=>this.onNewNetwork(e)),m.subscribeKey("activeCaipAddress",e=>this.onNewAddress(e)),O.subscribeKey("enableEmbedded",e=>this.enableEmbedded=e),G.subscribeKey("filterByNamespace",e=>{this.filterByNamespace!==e&&!m.getAccountData(e)?.caipAddress&&(U.fetchRecommendedWallets(),this.filterByNamespace=e)}))}firstUpdated(){if(this.caipAddress){if(this.enableEmbedded){v.close(),this.prefetch();return}this.onNewAddress(this.caipAddress)}this.open&&this.onOpen(),this.enableEmbedded&&this.prefetch()}disconnectedCallback(){this.unsubscribe.forEach(e=>e()),this.onRemoveKeyboardListener()}render(){return this.style.cssText=`
      --local-border-bottom-mobile-radius: ${this.enableEmbedded?"clamp(0px, var(--wui-border-radius-l), 44px)":"0px"};
    `,this.enableEmbedded?a`${this.contentTemplate()}
        <w3m-tooltip></w3m-tooltip> `:this.open?a`
          <wui-flex @click=${this.onOverlayClick.bind(this)} data-testid="w3m-modal-overlay">
            ${this.contentTemplate()}
          </wui-flex>
          <w3m-tooltip></w3m-tooltip>
        `:null}contentTemplate(){return a` <wui-card
      shake="${this.shake}"
      data-embedded="${Y(this.enableEmbedded)}"
      role="alertdialog"
      aria-modal="true"
      tabindex="0"
      data-testid="w3m-modal-card"
    >
      <w3m-header></w3m-header>
      <w3m-router></w3m-router>
      <w3m-snackbar></w3m-snackbar>
      <w3m-alertbar></w3m-alertbar>
    </wui-card>`}async onOverlayClick(e){e.target===e.currentTarget&&await this.handleClose()}async handleClose(){await ne.safeClose()}initializeTheming(){const{themeVariables:e,themeMode:t}=ke.state,o=ve.getColorTheme(t);Se(e,o)}onClose(){this.open=!1,this.classList.remove("open"),this.onScrollUnlock(),$.hide(),this.onRemoveKeyboardListener()}onOpen(){this.open=!0,this.classList.add("open"),this.onScrollLock(),this.onAddKeyboardListener()}onScrollLock(){const e=document.createElement("style");e.dataset.w3m=ee,e.textContent=`
      body {
        touch-action: none;
        overflow: hidden;
        overscroll-behavior: contain;
      }
      w3m-modal {
        pointer-events: auto;
      }
    `,document.head.appendChild(e)}onScrollUnlock(){const e=document.head.querySelector(`style[data-w3m="${ee}"]`);e&&e.remove()}onAddKeyboardListener(){this.abortController=new AbortController;const e=this.shadowRoot?.querySelector("wui-card");e?.focus(),window.addEventListener("keydown",t=>{if(t.key==="Escape")this.handleClose();else if(t.key==="Tab"){const{tagName:o}=t.target;o&&!o.includes("W3M-")&&!o.includes("WUI-")&&e?.focus()}},this.abortController)}onRemoveKeyboardListener(){this.abortController?.abort(),this.abortController=void 0}async onNewAddress(e){const t=m.state.isSwitchingNamespace,o=Ne.getPlainAddress(e);!o&&!t?v.close():t&&o&&l.goBack(),await oe.initializeIfEnabled(),this.caipAddress=e,m.setIsSwitchingNamespace(!1)}onNewNetwork(e){const t=this.caipNetwork,o=t?.caipNetworkId?.toString(),r=t?.chainNamespace,i=e?.caipNetworkId?.toString(),s=e?.chainNamespace,c=o!==i,we=c&&!(r!==s),de=t?.name===We.UNSUPPORTED_NETWORK_NAME,ue=l.state.view==="ConnectingExternal",pe=!m.getAccountData(e?.chainNamespace)?.caipAddress,me=l.state.view==="UnsupportedChain",he=v.state.open;let L=!1;he&&!ue&&(pe?c&&(L=!0):(me||we&&!de)&&(L=!0)),L&&l.state.view!=="SIWXSignMessage"&&l.goBack(),this.caipNetwork=e}prefetch(){this.hasPrefetched||(U.prefetch(),U.fetchWalletsByPage({page:1}),this.hasPrefetched=!0)}}y.styles=He;x([fe({type:Boolean})],y.prototype,"enableEmbedded",void 0);x([w()],y.prototype,"open",void 0);x([w()],y.prototype,"caipAddress",void 0);x([w()],y.prototype,"caipNetwork",void 0);x([w()],y.prototype,"shake",void 0);x([w()],y.prototype,"filterByNamespace",void 0);let te=class extends y{};te=x([u("w3m-modal")],te);let ie=class extends y{};ie=x([u("appkit-modal")],ie);export{ie as AppKitModal,te as W3mModal,y as W3mModalBase};
