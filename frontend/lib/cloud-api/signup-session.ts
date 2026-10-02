// Embedded Signup returns the OAuth code in FB.login and asset IDs via postMessage.
export function runSignupSession(configId: string, coexistence: boolean): Promise<{code:string;wabaId:string;phoneNumberId:string}> {
  return new Promise((resolve,reject)=>{
    let code='';let assets:{wabaId:string;phoneNumberId:string}|null=null
    const cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',receive)}
    const finish=()=>{if(code&&assets){cleanup();resolve({code,...assets})}}
    const fail=(message:string)=>{cleanup();reject(new Error(message))}
    const receive=(event:MessageEvent)=>{
      if(!['https://www.facebook.com','https://web.facebook.com'].includes(event.origin))return
      let data;try{data=typeof event.data==='string'?JSON.parse(event.data):event.data}catch{return}
      if(data?.type!=='WA_EMBEDDED_SIGNUP')return
      if(data.event==='CANCEL'||data.event==='ERROR'){fail('El registro de Meta fue cancelado o rechazado.');return}
      if(!['FINISH','FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'].includes(data.event))return
      if(!/^\d+$/.test(data.data?.waba_id)||!/^\d+$/.test(data.data?.phone_number_id))return
      assets={wabaId:data.data.waba_id,phoneNumberId:data.data.phone_number_id};finish()
    }
    const timer=setTimeout(()=>fail('Meta no devolvió todos los datos. Cerrá la ventana y volvé a intentar.'),120000)
    window.addEventListener('message',receive)
    try{window.FB.login(response=>{
      if(!response.authResponse?.code){fail('Meta no autorizó la conexión.');return}
      code=response.authResponse.code;finish()
    },{config_id:configId,response_type:'code',override_default_response_type:true,extras:{setup:{},sessionInfoVersion:3,...(coexistence?{featureType:'whatsapp_business_app_onboarding'}:{})}})}catch{fail('No se pudo abrir el registro de Meta.')}
  })
}
