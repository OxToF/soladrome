import{c as u,n as d,b as T,r as w,i as A,x as r,o as Y,U as ce,a as le}from"./index-mGwsZXJ1.js";import{p as we,s as de,q as ue,i as I,r as _,a as P,x as f,t as L,e as te,o as ie,R as l,n as v,f as V,j as pe,u as x,g as me,c as Q,v as G,M as h,O,C as q,w as Z,k as R,A as U,T as he,y as ve,b as fe,h as ge}from"./solana-DfUZBo5-.js";import"../main.mjs";import"./util-C_16CLeU.js";import"./wallets-CO31kUi4.js";import"./index.es-BctUhcbn.js";import"./http-D4bz-t0I.js";import"./big-DS5bVq7O.js";const m=we({message:"",open:!1,triggerRect:{width:0,height:0,top:0,left:0},variant:"shade"}),W={state:m,subscribe(n){return ue(m,()=>n(m))},subscribeKey(n,e){return de(m,n,e)},showTooltip({message:n,triggerRect:e,variant:t}){m.open=!0,m.message=n,m.triggerRect=e,m.variant=t},hide(){m.open=!1,m.message="",m.triggerRect={width:0,height:0,top:0,left:0}}},be=I`
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
`;var ye=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let F=class extends P{render(){return f`<slot></slot>`}};F.styles=[_,be];F=ye([u("wui-card")],F);const xe=I`
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
`;var B=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let C=class extends P{constructor(){super(...arguments),this.message="",this.backgroundColor="accent-100",this.iconColor="accent-100",this.icon="info"}render(){return this.style.cssText=`
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
    `}onClose(){L.close()}};C.styles=[_,xe];B([d()],C.prototype,"message",void 0);B([d()],C.prototype,"backgroundColor",void 0);B([d()],C.prototype,"iconColor",void 0);B([d()],C.prototype,"icon",void 0);C=B([u("wui-alertbar")],C);const Ce=T`
  :host {
    display: block;
    position: absolute;
    top: var(--wui-spacing-s);
    left: var(--wui-spacing-l);
    right: var(--wui-spacing-l);
    opacity: 0;
    pointer-events: none;
  }
`;var oe=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};const ke={info:{backgroundColor:"fg-350",iconColor:"fg-325",icon:"info"},success:{backgroundColor:"success-glass-reown-020",iconColor:"success-125",icon:"checkmark"},warning:{backgroundColor:"warning-glass-reown-020",iconColor:"warning-100",icon:"warningCircle"},error:{backgroundColor:"error-glass-reown-020",iconColor:"error-125",icon:"exclamationTriangle"}};let z=class extends A{constructor(){super(),this.unsubscribe=[],this.open=L.state.open,this.onOpen(!0),this.unsubscribe.push(L.subscribeKey("open",e=>{this.open=e,this.onOpen(!1)}))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){const{message:e,variant:t}=L.state,o=ke[t];return r`
      <wui-alertbar
        message=${e}
        backgroundColor=${o?.backgroundColor}
        iconColor=${o?.iconColor}
        icon=${o?.icon}
      ></wui-alertbar>
    `}onOpen(e){this.open?(this.animate([{opacity:0,transform:"scale(0.85)"},{opacity:1,transform:"scale(1)"}],{duration:150,fill:"forwards",easing:"ease"}),this.style.cssText="pointer-events: auto"):e||(this.animate([{opacity:1,transform:"scale(1)"},{opacity:0,transform:"scale(0.85)"}],{duration:150,fill:"forwards",easing:"ease"}),this.style.cssText="pointer-events: none")}};z.styles=Ce;oe([w()],z.prototype,"open",void 0);z=oe([u("w3m-alertbar")],z);const Se=I`
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
`;var D=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let k=class extends P{constructor(){super(...arguments),this.size="md",this.disabled=!1,this.icon="copy",this.iconColor="inherit"}render(){const e=this.size==="lg"?"--wui-border-radius-xs":"--wui-border-radius-xxs",t=this.size==="lg"?"--wui-spacing-1xs":"--wui-spacing-2xs";return this.style.cssText=`
    --local-border-radius: var(${e});
    --local-padding: var(${t});
`,f`
      <button ?disabled=${this.disabled}>
        <wui-icon color=${this.iconColor} size=${this.size} name=${this.icon}></wui-icon>
      </button>
    `}};k.styles=[_,te,ie,Se];D([d()],k.prototype,"size",void 0);D([d({type:Boolean})],k.prototype,"disabled",void 0);D([d()],k.prototype,"icon",void 0);D([d()],k.prototype,"iconColor",void 0);k=D([u("wui-icon-link")],k);const Ne=I`
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
`;var re=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let H=class extends P{constructor(){super(...arguments),this.imageSrc=""}render(){return f`<button>
      ${this.imageTemplate()}
      <wui-icon size="xs" color="fg-200" name="chevronBottom"></wui-icon>
    </button>`}imageTemplate(){return this.imageSrc?f`<wui-image src=${this.imageSrc} alt="select visual"></wui-image>`:f`<wui-icon-box
      size="xxs"
      iconColor="fg-200"
      backgroundColor="fg-100"
      background="opaque"
      icon="networkPlaceholder"
    ></wui-icon-box>`}};H.styles=[_,te,ie,Ne];re([d()],H.prototype,"imageSrc",void 0);H=re([u("wui-select")],H);const $e=T`
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
`;var g=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};const Re=["SmartSessionList"];function X(){const n=l.state.data?.connector?.name,e=l.state.data?.wallet?.name,t=l.state.data?.network?.name,o=e??n,a=q.getConnectors();return{Connect:`Connect ${a.length===1&&a[0]?.id==="w3m-email"?"Email":""} Wallet`,Create:"Create Wallet",ChooseAccountName:void 0,Account:void 0,AccountSettings:void 0,AllWallets:"All Wallets",ApproveTransaction:"Approve Transaction",BuyInProgress:"Buy",ConnectingExternal:o??"Connect Wallet",ConnectingWalletConnect:o??"WalletConnect",ConnectingWalletConnectBasic:"WalletConnect",ConnectingSiwe:"Sign In",Convert:"Convert",ConvertSelectToken:"Select token",ConvertPreview:"Preview convert",Downloads:o?`Get ${o}`:"Downloads",EmailLogin:"Email Login",EmailVerifyOtp:"Confirm Email",EmailVerifyDevice:"Register Device",GetWallet:"Get a wallet",Networks:"Choose Network",OnRampProviders:"Choose Provider",OnRampActivity:"Activity",OnRampTokenSelect:"Select Token",OnRampFiatSelect:"Select Currency",Profile:void 0,SwitchNetwork:t??"Switch Network",SwitchAddress:"Switch Address",Transactions:"Activity",UnsupportedChain:"Switch Network",UpgradeEmailWallet:"Upgrade your Wallet",UpdateEmailWallet:"Edit Email",UpdateEmailPrimaryOtp:"Confirm Current Email",UpdateEmailSecondaryOtp:"Confirm New Email",WhatIsABuy:"What is Buy?",RegisterAccountName:"Choose name",RegisterAccountNameSuccess:"",WalletReceive:"Receive",WalletCompatibleNetworks:"Compatible Networks",Swap:"Swap",SwapSelectToken:"Select token",SwapPreview:"Preview swap",WalletSend:"Send",WalletSendPreview:"Review send",WalletSendSelectToken:"Select Token",WhatIsANetwork:"What is a network?",WhatIsAWallet:"What is a wallet?",ConnectWallets:"Connect wallet",ConnectSocials:"All socials",ConnectingSocial:Z.state.socialProvider?Z.state.socialProvider:"Connect Social",ConnectingMultiChain:"Select chain",ConnectingFarcaster:"Farcaster",SwitchActiveChain:"Switch chain",SmartSessionCreated:void 0,SmartSessionList:"Smart Sessions",SIWXSignMessage:"Sign In"}}let p=class extends A{constructor(){super(),this.unsubscribe=[],this.heading=X()[l.state.view],this.network=v.state.activeCaipNetwork,this.networkImage=V.getNetworkImage(this.network),this.buffering=!1,this.showBack=!1,this.prevHistoryLength=1,this.view=l.state.view,this.viewDirection="",this.headerText=X()[l.state.view],this.unsubscribe.push(pe.subscribeNetworkImages(()=>{this.networkImage=V.getNetworkImage(this.network)}),l.subscribeKey("view",e=>{setTimeout(()=>{this.view=e,this.headerText=X()[e]},x.ANIMATION_DURATIONS.HeaderText),this.onViewChange(),this.onHistoryChange()}),me.subscribeKey("buffering",e=>this.buffering=e),v.subscribeKey("activeCaipNetwork",e=>{this.network=e,this.networkImage=V.getNetworkImage(this.network)}))}disconnectCallback(){this.unsubscribe.forEach(e=>e())}render(){return r`
      <wui-flex .padding=${this.getPadding()} justifyContent="space-between" alignItems="center">
        ${this.leftHeaderTemplate()} ${this.titleTemplate()} ${this.rightHeaderTemplate()}
      </wui-flex>
    `}onWalletHelp(){Q.sendEvent({type:"track",event:"CLICK_WALLET_HELP"}),l.push("WhatIsAWallet")}async onClose(){l.state.view==="UnsupportedChain"||await G.isSIWXCloseDisabled()?h.shake():h.close()}rightHeaderTemplate(){const e=O?.state?.features?.smartSessions;return l.state.view!=="Account"||!e?this.closeButtonTemplate():r`<wui-flex>
      <wui-icon-link
        icon="clock"
        @click=${()=>l.push("SmartSessionList")}
        data-testid="w3m-header-smart-sessions"
      ></wui-icon-link>
      ${this.closeButtonTemplate()}
    </wui-flex> `}closeButtonTemplate(){return r`
      <wui-icon-link
        ?disabled=${this.buffering}
        icon="close"
        @click=${this.onClose.bind(this)}
        data-testid="w3m-header-close"
      ></wui-icon-link>
    `}titleTemplate(){const e=Re.includes(this.view);return r`
      <wui-flex
        view-direction="${this.viewDirection}"
        class="w3m-header-title"
        alignItems="center"
        gap="xs"
      >
        <wui-text variant="paragraph-700" color="fg-100" data-testid="w3m-header-text"
          >${this.headerText}</wui-text
        >
        ${e?r`<wui-tag variant="main">Beta</wui-tag>`:null}
      </wui-flex>
    `}leftHeaderTemplate(){const{view:e}=l.state,t=e==="Connect",o=O.state.enableEmbedded,a=e==="ApproveTransaction",i=e==="ConnectingSiwe",s=e==="Account",c=O.state.enableNetworkSwitch,M=a||i||t&&o;return s&&c?r`<wui-select
        id="dynamic"
        data-testid="w3m-account-select-network"
        active-network=${Y(this.network?.name)}
        @click=${this.onNetworks.bind(this)}
        imageSrc=${Y(this.networkImage)}
      ></wui-select>`:this.showBack&&!M?r`<wui-icon-link
        data-testid="header-back"
        id="dynamic"
        icon="chevronLeft"
        ?disabled=${this.buffering}
        @click=${this.onGoBack.bind(this)}
      ></wui-icon-link>`:r`<wui-icon-link
      data-hidden=${!t}
      id="dynamic"
      icon="helpCircle"
      @click=${this.onWalletHelp.bind(this)}
    ></wui-icon-link>`}onNetworks(){this.isAllowedNetworkSwitch()&&(Q.sendEvent({type:"track",event:"CLICK_NETWORKS"}),l.push("Networks"))}isAllowedNetworkSwitch(){const e=v.getAllRequestedCaipNetworks(),t=e?e.length>1:!1,o=e?.find(({id:a})=>a===this.network?.id);return t||!o}getPadding(){return this.heading?["l","2l","l","2l"]:["0","2l","0","2l"]}onViewChange(){const{history:e}=l.state;let t=x.VIEW_DIRECTION.Next;e.length<this.prevHistoryLength&&(t=x.VIEW_DIRECTION.Prev),this.prevHistoryLength=e.length,this.viewDirection=t}async onHistoryChange(){const{history:e}=l.state,t=this.shadowRoot?.querySelector("#dynamic");e.length>1&&!this.showBack&&t?(await t.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.showBack=!0,t.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"})):e.length<=1&&this.showBack&&t&&(await t.animate([{opacity:1},{opacity:0}],{duration:200,fill:"forwards",easing:"ease"}).finished,this.showBack=!1,t.animate([{opacity:0},{opacity:1}],{duration:200,fill:"forwards",easing:"ease"}))}onGoBack(){l.goBack()}};p.styles=$e;g([w()],p.prototype,"heading",void 0);g([w()],p.prototype,"network",void 0);g([w()],p.prototype,"networkImage",void 0);g([w()],p.prototype,"buffering",void 0);g([w()],p.prototype,"showBack",void 0);g([w()],p.prototype,"prevHistoryLength",void 0);g([w()],p.prototype,"view",void 0);g([w()],p.prototype,"viewDirection",void 0);g([w()],p.prototype,"headerText",void 0);p=g([u("w3m-header")],p);const We=I`
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
`;var N=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let b=class extends P{constructor(){super(...arguments),this.backgroundColor="accent-100",this.iconColor="accent-100",this.icon="checkmark",this.message="",this.loading=!1,this.iconType="default"}render(){return f`
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
    ></wui-icon-box>`}};b.styles=[_,We];N([d()],b.prototype,"backgroundColor",void 0);N([d()],b.prototype,"iconColor",void 0);N([d()],b.prototype,"icon",void 0);N([d()],b.prototype,"message",void 0);N([d()],b.prototype,"loading",void 0);N([d()],b.prototype,"iconType",void 0);b=N([u("wui-snackbar")],b);const Te=T`
  :host {
    display: block;
    position: absolute;
    opacity: 0;
    pointer-events: none;
    top: 11px;
    left: 50%;
    width: max-content;
  }
`;var ae=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};const Ae={loading:void 0,success:{backgroundColor:"success-100",iconColor:"success-100",icon:"checkmark"},error:{backgroundColor:"error-100",iconColor:"error-100",icon:"close"}};let K=class extends A{constructor(){super(),this.unsubscribe=[],this.timeout=void 0,this.open=R.state.open,this.unsubscribe.push(R.subscribeKey("open",e=>{this.open=e,this.onOpen()}))}disconnectedCallback(){clearTimeout(this.timeout),this.unsubscribe.forEach(e=>e())}render(){const{message:e,variant:t,svg:o}=R.state,a=Ae[t],{icon:i,iconColor:s}=o??a??{};return r`
      <wui-snackbar
        message=${e}
        backgroundColor=${a?.backgroundColor}
        iconColor=${s}
        icon=${i}
        .loading=${t==="loading"}
      ></wui-snackbar>
    `}onOpen(){clearTimeout(this.timeout),this.open?(this.animate([{opacity:0,transform:"translateX(-50%) scale(0.85)"},{opacity:1,transform:"translateX(-50%) scale(1)"}],{duration:150,fill:"forwards",easing:"ease"}),this.timeout&&clearTimeout(this.timeout),R.state.autoClose&&(this.timeout=setTimeout(()=>R.hide(),2500))):this.animate([{opacity:1,transform:"translateX(-50%) scale(1)"},{opacity:0,transform:"translateX(-50%) scale(0.85)"}],{duration:150,fill:"forwards",easing:"ease"})}};K.styles=Te;ae([w()],K.prototype,"open",void 0);K=ae([u("w3m-snackbar")],K);const Oe=T`
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
`;var j=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let S=class extends A{constructor(){super(),this.unsubscribe=[],this.open=W.state.open,this.message=W.state.message,this.triggerRect=W.state.triggerRect,this.variant=W.state.variant,this.unsubscribe.push(W.subscribe(e=>{this.open=e.open,this.message=e.message,this.triggerRect=e.triggerRect,this.variant=e.variant}))}disconnectedCallback(){this.unsubscribe.forEach(e=>e())}render(){this.dataset.variant=this.variant;const e=this.triggerRect.top,t=this.triggerRect.left;return this.style.cssText=`
    --w3m-tooltip-top: ${e}px;
    --w3m-tooltip-left: ${t}px;
    --w3m-tooltip-parent-width: ${this.triggerRect.width/2}px;
    --w3m-tooltip-display: ${this.open?"flex":"none"};
    --w3m-tooltip-opacity: ${this.open?1:0};
    `,r`<wui-flex>
      <wui-icon data-placement="top" color="fg-100" size="inherit" name="cursor"></wui-icon>
      <wui-text color="inherit" variant="small-500">${this.message}</wui-text>
    </wui-flex>`}};S.styles=[Oe];j([w()],S.prototype,"open",void 0);j([w()],S.prototype,"message",void 0);j([w()],S.prototype,"triggerRect",void 0);j([w()],S.prototype,"variant",void 0);S=j([u("w3m-tooltip"),u("w3m-tooltip")],S);const Ee=T`
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
`;var J=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};let E=class extends A{constructor(){super(),this.resizeObserver=void 0,this.prevHeight="0px",this.prevHistoryLength=1,this.unsubscribe=[],this.view=l.state.view,this.viewDirection="",this.unsubscribe.push(l.subscribeKey("view",e=>this.onViewChange(e)))}firstUpdated(){this.resizeObserver=new ResizeObserver(([e])=>{const t=`${e?.contentRect.height}px`;this.prevHeight!=="0px"&&(this.style.setProperty("--prev-height",this.prevHeight),this.style.setProperty("--new-height",t),this.style.animation="w3m-view-height 150ms forwards ease",this.style.height="auto"),setTimeout(()=>{this.prevHeight=t,this.style.animation="unset"},x.ANIMATION_DURATIONS.ModalHeight)}),this.resizeObserver?.observe(this.getWrapper())}disconnectedCallback(){this.resizeObserver?.unobserve(this.getWrapper()),this.unsubscribe.forEach(e=>e())}render(){return r`<div class="w3m-router-container" view-direction="${this.viewDirection}">
      ${this.viewTemplate()}
    </div>`}viewTemplate(){switch(this.view){case"AccountSettings":return r`<w3m-account-settings-view></w3m-account-settings-view>`;case"Account":return r`<w3m-account-view></w3m-account-view>`;case"AllWallets":return r`<w3m-all-wallets-view></w3m-all-wallets-view>`;case"ApproveTransaction":return r`<w3m-approve-transaction-view></w3m-approve-transaction-view>`;case"BuyInProgress":return r`<w3m-buy-in-progress-view></w3m-buy-in-progress-view>`;case"ChooseAccountName":return r`<w3m-choose-account-name-view></w3m-choose-account-name-view>`;case"Connect":return r`<w3m-connect-view></w3m-connect-view>`;case"Create":return r`<w3m-connect-view walletGuide="explore"></w3m-connect-view>`;case"ConnectingWalletConnect":return r`<w3m-connecting-wc-view></w3m-connecting-wc-view>`;case"ConnectingWalletConnectBasic":return r`<w3m-connecting-wc-basic-view></w3m-connecting-wc-basic-view>`;case"ConnectingExternal":return r`<w3m-connecting-external-view></w3m-connecting-external-view>`;case"ConnectingSiwe":return r`<w3m-connecting-siwe-view></w3m-connecting-siwe-view>`;case"ConnectWallets":return r`<w3m-connect-wallets-view></w3m-connect-wallets-view>`;case"ConnectSocials":return r`<w3m-connect-socials-view></w3m-connect-socials-view>`;case"ConnectingSocial":return r`<w3m-connecting-social-view></w3m-connecting-social-view>`;case"Downloads":return r`<w3m-downloads-view></w3m-downloads-view>`;case"EmailLogin":return r`<w3m-email-login-view></w3m-email-login-view>`;case"EmailVerifyOtp":return r`<w3m-email-verify-otp-view></w3m-email-verify-otp-view>`;case"EmailVerifyDevice":return r`<w3m-email-verify-device-view></w3m-email-verify-device-view>`;case"GetWallet":return r`<w3m-get-wallet-view></w3m-get-wallet-view>`;case"Networks":return r`<w3m-networks-view></w3m-networks-view>`;case"SwitchNetwork":return r`<w3m-network-switch-view></w3m-network-switch-view>`;case"Profile":return r`<w3m-profile-view></w3m-profile-view>`;case"SwitchAddress":return r`<w3m-switch-address-view></w3m-switch-address-view>`;case"Transactions":return r`<w3m-transactions-view></w3m-transactions-view>`;case"OnRampProviders":return r`<w3m-onramp-providers-view></w3m-onramp-providers-view>`;case"OnRampActivity":return r`<w3m-onramp-activity-view></w3m-onramp-activity-view>`;case"OnRampTokenSelect":return r`<w3m-onramp-token-select-view></w3m-onramp-token-select-view>`;case"OnRampFiatSelect":return r`<w3m-onramp-fiat-select-view></w3m-onramp-fiat-select-view>`;case"UpgradeEmailWallet":return r`<w3m-upgrade-wallet-view></w3m-upgrade-wallet-view>`;case"UpdateEmailWallet":return r`<w3m-update-email-wallet-view></w3m-update-email-wallet-view>`;case"UpdateEmailPrimaryOtp":return r`<w3m-update-email-primary-otp-view></w3m-update-email-primary-otp-view>`;case"UpdateEmailSecondaryOtp":return r`<w3m-update-email-secondary-otp-view></w3m-update-email-secondary-otp-view>`;case"UnsupportedChain":return r`<w3m-unsupported-chain-view></w3m-unsupported-chain-view>`;case"Swap":return r`<w3m-swap-view></w3m-swap-view>`;case"SwapSelectToken":return r`<w3m-swap-select-token-view></w3m-swap-select-token-view>`;case"SwapPreview":return r`<w3m-swap-preview-view></w3m-swap-preview-view>`;case"WalletSend":return r`<w3m-wallet-send-view></w3m-wallet-send-view>`;case"WalletSendSelectToken":return r`<w3m-wallet-send-select-token-view></w3m-wallet-send-select-token-view>`;case"WalletSendPreview":return r`<w3m-wallet-send-preview-view></w3m-wallet-send-preview-view>`;case"WhatIsABuy":return r`<w3m-what-is-a-buy-view></w3m-what-is-a-buy-view>`;case"WalletReceive":return r`<w3m-wallet-receive-view></w3m-wallet-receive-view>`;case"WalletCompatibleNetworks":return r`<w3m-wallet-compatible-networks-view></w3m-wallet-compatible-networks-view>`;case"WhatIsAWallet":return r`<w3m-what-is-a-wallet-view></w3m-what-is-a-wallet-view>`;case"ConnectingMultiChain":return r`<w3m-connecting-multi-chain-view></w3m-connecting-multi-chain-view>`;case"WhatIsANetwork":return r`<w3m-what-is-a-network-view></w3m-what-is-a-network-view>`;case"ConnectingFarcaster":return r`<w3m-connecting-farcaster-view></w3m-connecting-farcaster-view>`;case"SwitchActiveChain":return r`<w3m-switch-active-chain-view></w3m-switch-active-chain-view>`;case"RegisterAccountName":return r`<w3m-register-account-name-view></w3m-register-account-name-view>`;case"RegisterAccountNameSuccess":return r`<w3m-register-account-name-success-view></w3m-register-account-name-success-view>`;case"SmartSessionCreated":return r`<w3m-smart-session-created-view></w3m-smart-session-created-view>`;case"SmartSessionList":return r`<w3m-smart-session-list-view></w3m-smart-session-list-view>`;case"SIWXSignMessage":return r`<w3m-siwx-sign-message-view></w3m-siwx-sign-message-view>`;default:return r`<w3m-connect-view></w3m-connect-view>`}}onViewChange(e){W.hide();let t=x.VIEW_DIRECTION.Next;const{history:o}=l.state;o.length<this.prevHistoryLength&&(t=x.VIEW_DIRECTION.Prev),this.prevHistoryLength=o.length,this.viewDirection=t,setTimeout(()=>{this.view=e},x.ANIMATION_DURATIONS.ViewTransition)}getWrapper(){return this.shadowRoot?.querySelector("div")}};E.styles=Ee;J([w()],E.prototype,"view",void 0);J([w()],E.prototype,"viewDirection",void 0);E=J([u("w3m-router")],E);const Ie=T`
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

  :host(.embedded) {
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

  :host(.embedded) wui-card {
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
`;var $=function(n,e,t,o){var a=arguments.length,i=a<3?e:o===null?o=Object.getOwnPropertyDescriptor(e,t):o,s;if(typeof Reflect=="object"&&typeof Reflect.decorate=="function")i=Reflect.decorate(n,e,t,o);else for(var c=n.length-1;c>=0;c--)(s=n[c])&&(i=(a<3?s(i):a>3?s(e,t,i):s(e,t))||i);return a>3&&i&&Object.defineProperty(e,t,i),i};const ee="scroll-lock";let y=class extends A{constructor(){super(),this.unsubscribe=[],this.abortController=void 0,this.hasPrefetched=!1,this.enableEmbedded=O.state.enableEmbedded,this.open=h.state.open,this.caipAddress=v.state.activeCaipAddress,this.caipNetwork=v.state.activeCaipNetwork,this.shake=h.state.shake,this.filterByNamespace=q.state.filterByNamespace,this.initializeTheming(),U.prefetchAnalyticsConfig(),this.unsubscribe.push(h.subscribeKey("open",e=>e?this.onOpen():this.onClose()),h.subscribeKey("shake",e=>this.shake=e),v.subscribeKey("activeCaipNetwork",e=>this.onNewNetwork(e)),v.subscribeKey("activeCaipAddress",e=>this.onNewAddress(e)),O.subscribeKey("enableEmbedded",e=>this.enableEmbedded=e),q.subscribeKey("filterByNamespace",e=>{this.filterByNamespace!==e&&!v.getAccountData(e)?.caipAddress&&(U.fetchRecommendedWallets(),this.filterByNamespace=e)}))}firstUpdated(){if(this.caipAddress){if(this.enableEmbedded){h.close(),this.prefetch();return}this.onNewAddress(this.caipAddress)}this.open&&this.onOpen(),this.enableEmbedded&&this.prefetch()}disconnectedCallback(){this.unsubscribe.forEach(e=>e()),this.onRemoveKeyboardListener()}render(){return this.style.cssText=`
      --local-border-bottom-mobile-radius: ${this.enableEmbedded?"clamp(0px, var(--wui-border-radius-l), 44px)":"0px"};
    `,this.enableEmbedded?r`${this.contentTemplate()}
        <w3m-tooltip></w3m-tooltip> `:this.open?r`
          <wui-flex @click=${this.onOverlayClick.bind(this)} data-testid="w3m-modal-overlay">
            ${this.contentTemplate()}
          </wui-flex>
          <w3m-tooltip></w3m-tooltip>
        `:null}contentTemplate(){return r` <wui-card
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
    </wui-card>`}async onOverlayClick(e){e.target===e.currentTarget&&await this.handleClose()}async handleClose(){l.state.view==="UnsupportedChain"||await G.isSIWXCloseDisabled()?h.shake():h.close()}initializeTheming(){const{themeVariables:e,themeMode:t}=he.state,o=ce.getColorTheme(t);ve(e,o)}onClose(){this.open=!1,this.classList.remove("open"),this.onScrollUnlock(),R.hide(),this.onRemoveKeyboardListener()}onOpen(){this.open=!0,this.classList.add("open"),this.onScrollLock(),this.onAddKeyboardListener()}onScrollLock(){const e=document.createElement("style");e.dataset.w3m=ee,e.textContent=`
      body {
        touch-action: none;
        overflow: hidden;
        overscroll-behavior: contain;
      }
      w3m-modal {
        pointer-events: auto;
      }
    `,document.head.appendChild(e)}onScrollUnlock(){const e=document.head.querySelector(`style[data-w3m="${ee}"]`);e&&e.remove()}onAddKeyboardListener(){this.abortController=new AbortController;const e=this.shadowRoot?.querySelector("wui-card");e?.focus(),window.addEventListener("keydown",t=>{if(t.key==="Escape")this.handleClose();else if(t.key==="Tab"){const{tagName:o}=t.target;o&&!o.includes("W3M-")&&!o.includes("WUI-")&&e?.focus()}},this.abortController)}onRemoveKeyboardListener(){this.abortController?.abort(),this.abortController=void 0}async onNewAddress(e){const t=v.state.isSwitchingNamespace,o=fe.getPlainAddress(e);!o&&!t?h.close():t&&o&&l.goBack(),await G.initializeIfEnabled(),this.caipAddress=e,v.setIsSwitchingNamespace(!1)}onNewNetwork(e){const t=this.caipNetwork?.caipNetworkId?.toString(),o=e?.caipNetworkId?.toString(),a=t&&o&&t!==o,i=v.state.isSwitchingNamespace,s=this.caipNetwork?.name===ge.UNSUPPORTED_NETWORK_NAME,c=l.state.view==="ConnectingExternal",M=!this.caipAddress,ne=a&&!s&&!i,se=l.state.view==="UnsupportedChain";h.state.open&&!c&&(M||se||ne)&&l.goBack(),this.caipNetwork=e}prefetch(){this.hasPrefetched||(U.prefetch(),U.fetchWallets({page:1}),this.hasPrefetched=!0)}};y.styles=Ie;$([le({type:Boolean})],y.prototype,"enableEmbedded",void 0);$([w()],y.prototype,"open",void 0);$([w()],y.prototype,"caipAddress",void 0);$([w()],y.prototype,"caipNetwork",void 0);$([w()],y.prototype,"shake",void 0);$([w()],y.prototype,"filterByNamespace",void 0);y=$([u("w3m-modal")],y);export{y as W3mModal};
