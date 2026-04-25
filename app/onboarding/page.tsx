import React,{useEffect,useRef,useState}from'react'
import{
  View,Text,StyleSheet,TouchableOpacity,TextInput,
  Animated,Easing,
  ScrollView,Dimensions,Keyboard,
}from'react-native'
import{useSafeAreaInsets}from'react-native-safe-area-context'
import{KeyboardStickyView}from'react-native-keyboard-controller'
import*as Haptics from'expo-haptics'
import{useOnboarding,AnalysisResult}from'../hooks/useOnboarding'
import{MBTI_OPTIONS,MBTI_UNKNOWN_HEX}from'../lib/mbti'
import type{MBTICode}from'../lib/mbti'
import type{SelectQuestion,TextQuestion}from'../lib/onboarding'
import type{OnboardingPhase}from'../App'

const{width:SW}=Dimensions.get('window')
const ORB_AREA_HEIGHT=260

interface Props{
  onPulseMBTI:(color:[number,number,number])=>void
  onComplete:(result:AnalysisResult)=>void
  onSelectedMBTIChange:(code:MBTICode|'unknown'|null)=>void
  onPhaseChange:(phase:OnboardingPhase,subProgress:number)=>void
  onTypingFocus:(focused:boolean)=>void
}

export default function OnboardingScreen({onPulseMBTI,onComplete,onSelectedMBTIChange,onPhaseChange,onTypingFocus}:Props){
  const insets=useSafeAreaInsets()
  const o=useOnboarding()
  const[birthProgress,setBirthProgress]=useState(0)
  const[inBirth,setInBirth]=useState(false)

  useEffect(()=>{
    if(inBirth){
      onPhaseChange('birth',birthProgress)
      return
    }
    if(o.state.step==='welcome')onPhaseChange('welcome',0)
    else if(o.state.step==='profile')onPhaseChange('profile',0)
    else if(o.state.step==='questions'){
      const p=o.state.currentQ/9
      onPhaseChange('questions',p)
    }
    else if(o.state.step==='mbti')onPhaseChange('mbti',1)
    else if(o.state.step==='analyzing')onPhaseChange('analyzing',1)
    else if(o.state.step==='complete')onPhaseChange('complete',1)
  },[o.state.step,o.state.currentQ,inBirth,birthProgress])

  const goToQuestionsWithBirth=()=>{
    setInBirth(true)
    setBirthProgress(0)
    const start=Date.now()
    const DUR=2400
    const tick=()=>{
      const e=Date.now()-start
      if(e>=DUR){
        setBirthProgress(1)
        setInBirth(false)
        o.goToStep('questions')
        return
      }
      const raw=e/DUR
      const eased=1-Math.pow(1-raw,2)
      setBirthProgress(eased)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  if(!o.isHydrated){
    return(
      <View style={{flex:1,justifyContent:'center',alignItems:'center'}}>
        <Text style={{color:'rgba(255,255,255,0.2)',fontSize:12,letterSpacing:4}}>…</Text>
      </View>
    )
  }

  if(inBirth){
    return<View style={{flex:1}}/>
  }

  if(o.state.step==='analyzing'){
    return<AnalyzingView insetTop={insets.top}/>
  }
  if(o.state.step==='complete'&&o.result){
    return<CompleteView insetTop={insets.top} insetBottom={insets.bottom} result={o.result} onStart={()=>onComplete(o.result!)}/>
  }

  if(o.state.step==='welcome'){
    return(
      <View style={{flex:1,paddingTop:insets.top}}>
        <WelcomeView onStart={()=>o.goToStep('profile')} insetBottom={insets.bottom}/>
      </View>
    )
  }

  if(o.state.step==='profile'){
    return(
      <View style={{flex:1,paddingTop:insets.top}}>
        <ProfileView
          name={o.state.answers.name}
          company={o.state.answers.company}
          position={o.state.answers.position}
          onChange={o.setProfile}
          onBack={()=>o.goToStep('welcome')}
          onNext={goToQuestionsWithBirth}
          insetBottom={insets.bottom}
          onTypingFocus={onTypingFocus}
        />
      </View>
    )
  }

  return(
    <View style={{flex:1}}>
      <View style={{height:insets.top+ORB_AREA_HEIGHT}}/>
      <View style={{flex:1}}>
        {o.state.step==='questions'&&o.currentQuestion&&(
          <QuestionView
            q={o.currentQuestion}
            value={(o.state.answers as any)[o.currentQuestion.id]||''}
            progress={o.progressPercent}
            onAnswer={(v)=>{
              o.answerQuestion(o.currentQuestion!.id,v)
              if(o.currentQuestion!.type==='select'){
                setTimeout(()=>o.nextQuestion(),220)
              }
            }}
            onNext={()=>{Keyboard.dismiss();o.nextQuestion()}}
            onBack={()=>{Keyboard.dismiss();o.prevQuestion()}}
            insetBottom={insets.bottom}
            onTypingFocus={onTypingFocus}
          />
        )}
        {o.state.step==='mbti'&&(
          <MBTIView
            selected={o.state.answers.mbti??null}
            onSelect={(code)=>{
              o.setMBTI(code)
              onSelectedMBTIChange(code)
              if(code==='unknown'){
                onPulseMBTI([0.9,0.9,1.0])
              }else if(code){
                const opt=MBTI_OPTIONS.find(m=>m.code===code)
                if(opt)onPulseMBTI(opt.color as [number,number,number])
              }
            }}
            onBack={()=>o.goToStep('questions')}
            onSubmit={o.submit}
            error={o.error}
            isSubmitting={o.isSubmitting}
            insetBottom={insets.bottom}
          />
        )}
      </View>
    </View>
  )
}

function WelcomeView({onStart,insetBottom}:{onStart:()=>void;insetBottom:number}){
  const f1=useRef(new Animated.Value(0)).current
  const f2=useRef(new Animated.Value(0)).current
  const f3=useRef(new Animated.Value(0)).current

  useEffect(()=>{
    Animated.stagger(500,[
      Animated.timing(f1,{toValue:1,duration:1000,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(f2,{toValue:1,duration:1000,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(f3,{toValue:1,duration:1000,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
    ]).start()
  },[])

  return(
    <View style={[WC.wrap,{paddingBottom:insetBottom+48}]}>
      <Animated.Text style={[WC.title,{opacity:f1}]}>N O I D A</Animated.Text>
      <Animated.Text style={[WC.sub,{opacity:f2}]}>
        あなただけのAIを、{'\n'}これから迎えにいきます。
      </Animated.Text>
      <Animated.View style={[WC.btnWrap,{opacity:f3}]}>
        <TouchableOpacity
          style={WC.btn}
          activeOpacity={0.7}
          onPress={()=>{Haptics.selectionAsync();onStart()}}
        >
          <Text style={WC.btnText}>始める</Text>
        </TouchableOpacity>
      </Animated.View>
    </View>
  )
}

function ProfileView({
  name,company,position,onChange,onBack,onNext,insetBottom,onTypingFocus,
}:{
  name:string;company?:string;position?:string
  onChange:(p:{name:string;company?:string;position?:string})=>void
  onBack:()=>void;onNext:()=>void;insetBottom:number
  onTypingFocus:(focused:boolean)=>void
}){
  const canNext=name.trim().length>0
  const companyRef=useRef<TextInput>(null)
  const positionRef=useRef<TextInput>(null)

  return(
    <View style={{flex:1}}>
      <ScrollView
        style={{flex:1}}
        contentContainerStyle={{
          paddingHorizontal:32,
          paddingTop:40,
          paddingBottom:110,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={PV.label}>P R O F I L E</Text>
        <Text style={PV.question}>まず、あなたの{'\n'}情報を教えてください</Text>

        <View style={TF.wrap}>
          <Text style={TF.label}>お名前</Text>
          <TextInput
            style={TF.input}
            value={name}
            onChangeText={(v)=>onChange({name:v,company,position})}
            autoFocus
            returnKeyType="next"
            onFocus={()=>onTypingFocus(true)}
            onBlur={()=>onTypingFocus(false)}
            onSubmitEditing={()=>companyRef.current?.focus()}
            blurOnSubmit={false}
          />
        </View>

        <View style={TF.wrap}>
          <Text style={TF.label}>会社(任意)</Text>
          <TextInput
            ref={companyRef}
            style={TF.input}
            value={company??''}
            onChangeText={(v)=>onChange({name,company:v,position})}
            returnKeyType="next"
            onFocus={()=>onTypingFocus(true)}
            onBlur={()=>onTypingFocus(false)}
            onSubmitEditing={()=>positionRef.current?.focus()}
            blurOnSubmit={false}
          />
        </View>

        <View style={TF.wrap}>
          <Text style={TF.label}>役職(任意)</Text>
          <TextInput
            ref={positionRef}
            style={TF.input}
            value={position??''}
            onChangeText={(v)=>onChange({name,company,position:v})}
            returnKeyType="done"
            onFocus={()=>onTypingFocus(true)}
            onBlur={()=>onTypingFocus(false)}
            onSubmitEditing={()=>{
              if(canNext){
                Keyboard.dismiss()
                setTimeout(onNext,100)
              }
            }}
          />
        </View>
      </ScrollView>

      <KeyboardStickyView offset={{closed:0,opened:0}}>
        <View style={[PV.btnRowAbs,{position:'relative',paddingBottom:Math.max(insetBottom,12)}]}>
          <TouchableOpacity style={PV.btnBack} onPress={onBack} activeOpacity={0.6}>
            <Text style={PV.btnBackText}>戻る</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[PV.btnNext,!canNext&&PV.btnDisabled]}
            disabled={!canNext}
            onPress={()=>{Haptics.selectionAsync();Keyboard.dismiss();setTimeout(onNext,100)}}
            activeOpacity={0.7}
          >
            <Text style={PV.btnNextText}>次へ</Text>
          </TouchableOpacity>
        </View>
      </KeyboardStickyView>
    </View>
  )
}

function QuestionView({
  q,value,progress,onAnswer,onNext,onBack,insetBottom,onTypingFocus,
}:{
  q:SelectQuestion|TextQuestion
  value:string
  progress:number
  onAnswer:(v:string)=>void
  onNext:()=>void
  onBack:()=>void
  insetBottom:number
  onTypingFocus:(focused:boolean)=>void
}){
  const fade=useRef(new Animated.Value(0)).current

  useEffect(()=>{
    fade.setValue(0)
    Animated.timing(fade,{
      toValue:1,duration:400,
      easing:Easing.out(Easing.cubic),
      useNativeDriver:true,
    }).start()
  },[q.id])

  const canNext=q.type==='text'?value.trim().length>=q.minLength:!!value

  if(q.type==='text'){
    return(
      <View style={{flex:1}}>
        <Animated.View style={{flex:1,opacity:fade}}>
          <View style={{paddingHorizontal:32,paddingTop:4}}>
            <View style={QV.progressWrap}>
              <View style={QV.progressTrack}>
                <View style={[QV.progressFill,{width:`${progress}%`}]}/>
              </View>
              <Text style={QV.progressLabel}>{q.label}</Text>
            </View>
            <Text style={QV.question}>{q.question}</Text>
          </View>

          <View style={{marginTop:16,paddingHorizontal:32}}>
            <TextInput
              style={QV.textareaFlow}
              value={value}
              onChangeText={onAnswer}
              placeholder={q.placeholder}
              placeholderTextColor="rgba(255,255,255,0.22)"
              multiline
              autoFocus
              textAlignVertical="top"
              scrollEnabled={true}
              onFocus={()=>onTypingFocus(true)}
              onBlur={()=>onTypingFocus(false)}
            />
          </View>
        </Animated.View>

        <KeyboardStickyView offset={{closed:0,opened:0}}>
          <View style={[QV.btnRowAbs,{position:'relative',paddingBottom:Math.max(insetBottom,12)}]}>
            <TouchableOpacity style={QV.btnBack} onPress={onBack} activeOpacity={0.6}>
              <Text style={QV.btnBackText}>戻る</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[QV.btnNext,!canNext&&QV.btnDisabled]}
              disabled={!canNext}
              onPress={()=>{Haptics.selectionAsync();onNext()}}
              activeOpacity={0.7}
            >
              <Text style={QV.btnNextText}>次へ</Text>
            </TouchableOpacity>
          </View>
        </KeyboardStickyView>
      </View>
    )
  }

  return(
    <Animated.View style={{flex:1,opacity:fade}}>
      <ScrollView
        style={{flex:1}}
        contentContainerStyle={{paddingHorizontal:32,paddingTop:4,paddingBottom:90}}
        keyboardShouldPersistTaps="handled"
      >
        <View style={QV.progressWrap}>
          <View style={QV.progressTrack}>
            <View style={[QV.progressFill,{width:`${progress}%`}]}/>
          </View>
          <Text style={QV.progressLabel}>{q.label}</Text>
        </View>

        <Text style={QV.question}>{q.question}</Text>

        <View style={{marginTop:16}}>
          {q.options.map(opt=>{
            const selected=value===opt.value
            return(
              <TouchableOpacity
                key={opt.value}
                style={[QV.option,selected&&QV.optionSelected]}
                onPress={()=>{Haptics.selectionAsync();onAnswer(opt.value)}}
                activeOpacity={0.6}
              >
                <View style={[QV.dot,selected&&QV.dotSelected]}/>
                <Text style={[QV.optionText,selected&&QV.optionTextSelected]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            )
          })}
        </View>
      </ScrollView>

      <View style={[QV.btnRowAbs,{paddingBottom:Math.max(insetBottom,12)}]}>
        <TouchableOpacity style={QV.btnBack} onPress={onBack} activeOpacity={0.6}>
          <Text style={QV.btnBackText}>戻る</Text>
        </TouchableOpacity>
        <View style={{flex:2}}/>
      </View>
    </Animated.View>
  )
}

function MBTIView({
  selected,onSelect,onBack,onSubmit,error,isSubmitting,insetBottom,
}:{
  selected:MBTICode|'unknown'|null
  onSelect:(code:MBTICode|'unknown'|null)=>void
  onBack:()=>void
  onSubmit:()=>Promise<boolean>
  error:string|null
  isSubmitting:boolean
  insetBottom:number
}){
  return(
    <View style={{flex:1}}>
      <ScrollView
        style={{flex:1}}
        contentContainerStyle={{paddingHorizontal:20,paddingTop:4,paddingBottom:90}}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={MV.label}>最後の質問</Text>
        <Text style={MV.question}>
          もし知っていれば、{'\n'}MBTIを教えてください
        </Text>

        <View style={MV.grid}>
          {MBTI_OPTIONS.map(opt=>{
            const isSel=selected===opt.code
            return(
              <TouchableOpacity
                key={opt.code}
                style={[
                  MV.cell,
                  {
                    borderColor:isSel?opt.hex:`${opt.hex}33`,
                    backgroundColor:isSel?`${opt.hex}40`:`${opt.hex}0F`,
                  },
                ]}
                onPress={()=>{Haptics.selectionAsync();onSelect(opt.code)}}
                activeOpacity={0.7}
              >
                <View style={[MV.cellDot,{backgroundColor:opt.hex}]}/>
                <Text style={[MV.cellCode,isSel&&MV.cellCodeSelected]}>{opt.code}</Text>
                <Text style={[MV.cellName,isSel&&MV.cellNameSelected]}>{opt.name}</Text>
              </TouchableOpacity>
            )
          })}
        </View>

        <TouchableOpacity
          style={[
            MV.unknownBtn,
            selected==='unknown'&&{
              borderColor:MBTI_UNKNOWN_HEX,
              backgroundColor:`${MBTI_UNKNOWN_HEX}20`,
            },
          ]}
          onPress={()=>{Haptics.selectionAsync();onSelect('unknown')}}
          activeOpacity={0.7}
        >
          <View style={[MV.cellDot,{backgroundColor:MBTI_UNKNOWN_HEX}]}/>
          <Text style={MV.unknownText}>知らない / わからない</Text>
        </TouchableOpacity>

        {error&&<Text style={MV.error}>{error}</Text>}
      </ScrollView>

      <View style={[MV.btnRowAbs,{paddingBottom:Math.max(insetBottom,12)}]}>
        <TouchableOpacity style={MV.btnBack} onPress={onBack} activeOpacity={0.6}>
          <Text style={MV.btnBackText}>戻る</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[MV.btnNext,(!selected||isSubmitting)&&MV.btnDisabled]}
          disabled={!selected||isSubmitting}
          onPress={async()=>{
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
            await onSubmit()
          }}
          activeOpacity={0.7}
        >
          <Text style={MV.btnNextText}>{isSubmitting?'解析中…':'分析を開始'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function AnalyzingView({insetTop}:{insetTop:number}){
  const fade=useRef(new Animated.Value(0)).current
  const d1=useRef(new Animated.Value(0.3)).current
  const d2=useRef(new Animated.Value(0.3)).current
  const d3=useRef(new Animated.Value(0.3)).current

  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:800,useNativeDriver:true}).start()
    const animate=(v:Animated.Value,delay:number)=>{
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v,{toValue:1,duration:600,useNativeDriver:true}),
          Animated.timing(v,{toValue:0.3,duration:600,useNativeDriver:true}),
        ])
      ).start()
    }
    animate(d1,0)
    animate(d2,200)
    animate(d3,400)
  },[])

  return(
    <View style={{flex:1,paddingTop:insetTop+ORB_AREA_HEIGHT+40}}>
      <Animated.View style={[AV.wrap,{opacity:fade}]}>
        <Text style={AV.main}>あなたを{'\n'}読んでいます</Text>
        <View style={AV.dots}>
          <Animated.View style={[AV.dot,{opacity:d1}]}/>
          <Animated.View style={[AV.dot,{opacity:d2}]}/>
          <Animated.View style={[AV.dot,{opacity:d3}]}/>
        </View>
      </Animated.View>
    </View>
  )
}

function presetLabel(id:string):string{
  const map:Record<string,string>={
    decisive:'即断型',verifier:'検証型',optimizer:'最適化型',
    intuitive:'直感型',deliberator:'熟考型',iterator:'反復型',
    contrarian:'反骨型',relationship:'関係型',
  }
  return map[id]??id
}
function riskLabel(r:string):string{
  return r==='defensive'?'慎重':r==='aggressive'?'攻撃':'中庸'
}
function valueLabel(v:string):string{
  const map:Record<string,string>={
    revenue:'収益',growth:'成長',freedom:'自由',aesthetic:'美意識',
    stability:'安定',advantage:'優位',recognition:'承認',influence:'影響力',
  }
  return map[v]??v
}

function CompleteView({result,onStart,insetTop,insetBottom}:{result:AnalysisResult;onStart:()=>void;insetTop:number;insetBottom:number}){
  const t1=useRef(new Animated.Value(0)).current
  const t2=useRef(new Animated.Value(0)).current
  const t3=useRef(new Animated.Value(0)).current
  const t4=useRef(new Animated.Value(0)).current
  const t5=useRef(new Animated.Value(0)).current
  const t6=useRef(new Animated.Value(0)).current
  const t7=useRef(new Animated.Value(0)).current
  const confCount=useRef(new Animated.Value(0)).current
  const[displayConf,setDisplayConf]=useState(0)

  useEffect(()=>{
    Animated.stagger(400,[
      Animated.timing(t1,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(t2,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(t3,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(t4,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(t5,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(t6,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
      Animated.timing(confCount,{toValue:result.confidence*100,duration:1200,easing:Easing.out(Easing.cubic),useNativeDriver:false}),
      Animated.timing(t7,{toValue:1,duration:800,easing:Easing.out(Easing.cubic),useNativeDriver:true}),
    ]).start()
    const listener=confCount.addListener(({value})=>setDisplayConf(Math.round(value)))
    return()=>confCount.removeListener(listener)
  },[])

  return(
    <ScrollView
      style={{flex:1}}
      contentContainerStyle={{paddingTop:insetTop+ORB_AREA_HEIGHT+24,paddingHorizontal:24,paddingBottom:insetBottom+32,alignItems:'center'}}
    >
      <Animated.Text style={[CV.title,{opacity:t1}]}>完成しました</Animated.Text>
      <Animated.Text style={[CV.sub,{opacity:t2}]}>
        あなただけのNOIDAが、{'\n'}いま生まれました
      </Animated.Text>

      <View style={CV.cardRow}>
        <Animated.View style={[CV.card,{opacity:t3}]}>
          <Text style={CV.cardLabel}>判断</Text>
          <Text style={CV.cardValue}>{presetLabel(result.preset_id)}</Text>
        </Animated.View>
        <Animated.View style={[CV.card,{opacity:t4}]}>
          <Text style={CV.cardLabel}>姿勢</Text>
          <Text style={CV.cardValue}>{riskLabel(result.risk_stance)}</Text>
        </Animated.View>
        <Animated.View style={[CV.card,{opacity:t5}]}>
          <Text style={CV.cardLabel}>価値</Text>
          <Text style={CV.cardValue}>{valueLabel(result.value_driver)}</Text>
        </Animated.View>
      </View>

      <Animated.View style={[CV.matchWrap,{opacity:t6}]}>
        <Text style={CV.matchLabel}>マッチ精度</Text>
        <Text style={CV.matchValue}>{displayConf}%</Text>
      </Animated.View>

      {result.summary&&(
        <Animated.Text style={[CV.summary,{opacity:t6}]}>{result.summary}</Animated.Text>
      )}

      <Animated.View style={[CV.btnWrap,{opacity:t7}]}>
        <TouchableOpacity
          style={CV.btn}
          onPress={()=>{Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);onStart()}}
          activeOpacity={0.7}
        >
          <Text style={CV.btnText}>はじめる</Text>
        </TouchableOpacity>
      </Animated.View>
    </ScrollView>
  )
}

const WC=StyleSheet.create({
  wrap:{flex:1,paddingHorizontal:32,alignItems:'center',justifyContent:'center',gap:32},
  title:{fontSize:28,fontWeight:'200',color:'white',letterSpacing:10},
  sub:{fontSize:15,color:'rgba(255,255,255,0.55)',textAlign:'center',lineHeight:26,letterSpacing:0.5},
  btnWrap:{width:'100%',alignItems:'center'},
  btn:{width:'80%',paddingVertical:16,borderRadius:14,backgroundColor:'rgba(255,255,255,0.08)',borderWidth:0.5,borderColor:'rgba(255,255,255,0.2)',alignItems:'center'},
  btnText:{fontSize:13,color:'white',letterSpacing:2,fontWeight:'500'},
})

const PV=StyleSheet.create({
  label:{fontSize:10,letterSpacing:6,color:'rgba(255,255,255,0.3)',marginBottom:12,marginTop:4},
  question:{fontSize:20,color:'white',lineHeight:30,marginBottom:28,fontWeight:'300'},
  btnRowAbs:{
    position:'absolute',left:0,right:0,bottom:0,
    flexDirection:'row',gap:12,
    paddingHorizontal:32,paddingTop:12,
    backgroundColor:'#060608',
    borderTopWidth:0.5,borderTopColor:'rgba(255,255,255,0.05)',
  },
  btnBack:{flex:1,paddingVertical:14,alignItems:'center'},
  btnBackText:{fontSize:12,color:'rgba(255,255,255,0.4)',letterSpacing:2},
  btnNext:{flex:2,paddingVertical:14,borderRadius:14,backgroundColor:'rgba(255,255,255,0.08)',borderWidth:0.5,borderColor:'rgba(255,255,255,0.2)',alignItems:'center'},
  btnNextText:{fontSize:13,color:'white',letterSpacing:2,fontWeight:'500'},
  btnDisabled:{opacity:0.3},
})

const TF=StyleSheet.create({
  wrap:{marginBottom:22},
  label:{fontSize:10,letterSpacing:2,color:'rgba(255,255,255,0.4)',marginBottom:6},
  input:{fontSize:16,color:'white',paddingVertical:8,borderBottomWidth:0.5,borderBottomColor:'rgba(255,255,255,0.25)'},
})

const QV=StyleSheet.create({
  progressWrap:{marginBottom:16},
  progressTrack:{width:'100%',height:1.5,backgroundColor:'rgba(255,255,255,0.08)',borderRadius:1,marginBottom:6,overflow:'hidden'},
  progressFill:{height:'100%',backgroundColor:'rgba(255,255,255,0.65)',borderRadius:1},
  progressLabel:{fontSize:10,letterSpacing:4,color:'rgba(255,255,255,0.3)'},
  question:{fontSize:20,color:'white',lineHeight:30,fontWeight:'300'},
  option:{flexDirection:'row',alignItems:'center',paddingVertical:13,paddingHorizontal:14,marginBottom:4,borderRadius:10,gap:14},
  optionSelected:{backgroundColor:'rgba(255,255,255,0.06)'},
  dot:{width:6,height:6,borderRadius:4,borderWidth:1,borderColor:'rgba(255,255,255,0.3)'},
  dotSelected:{backgroundColor:'white',borderColor:'white'},
  textareaFlow:{
    height:26*3+24,
    fontSize:17,color:'white',
    paddingVertical:12,
    lineHeight:26,fontWeight:'300',
  },
  optionText:{fontSize:15,color:'rgba(255,255,255,0.7)',flex:1,letterSpacing:0.3},
  optionTextSelected:{color:'white'},
  btnRowAbs:{
    position:'absolute',left:0,right:0,bottom:0,
    flexDirection:'row',gap:12,
    paddingHorizontal:32,paddingTop:12,
    backgroundColor:'#060608',
    borderTopWidth:0.5,borderTopColor:'rgba(255,255,255,0.05)',
  },
  btnBack:{flex:1,paddingVertical:14,alignItems:'center'},
  btnBackText:{fontSize:12,color:'rgba(255,255,255,0.4)',letterSpacing:2},
  btnNext:{flex:2,paddingVertical:14,borderRadius:14,backgroundColor:'rgba(255,255,255,0.08)',borderWidth:0.5,borderColor:'rgba(255,255,255,0.2)',alignItems:'center'},
  btnNextText:{fontSize:13,color:'white',letterSpacing:2,fontWeight:'500'},
  btnDisabled:{opacity:0.3},
})

const MV=StyleSheet.create({
  label:{fontSize:10,letterSpacing:6,color:'rgba(255,255,255,0.3)',marginBottom:10,paddingHorizontal:4},
  question:{fontSize:18,color:'white',lineHeight:28,fontWeight:'300',marginBottom:20,paddingHorizontal:4},
  grid:{flexDirection:'row',flexWrap:'wrap',gap:8,marginBottom:12},
  cell:{
    width:(SW-20*2-8*3)/4,aspectRatio:1.3,
    borderRadius:10,borderWidth:0.8,
    alignItems:'center',justifyContent:'center',
    gap:3,
    paddingVertical:6,
  },
  cellDot:{width:5,height:5,borderRadius:3,marginBottom:2},
  cellCode:{fontSize:12,color:'rgba(255,255,255,0.7)',letterSpacing:1.5,fontWeight:'500'},
  cellCodeSelected:{color:'white'},
  cellName:{fontSize:9,color:'rgba(255,255,255,0.45)',letterSpacing:0.3,fontWeight:'300',marginTop:1},
  cellNameSelected:{color:'rgba(255,255,255,0.85)'},
  unknownBtn:{
    marginTop:6,paddingVertical:12,borderRadius:10,
    borderWidth:0.8,borderColor:`${MBTI_UNKNOWN_HEX}33`,
    backgroundColor:`${MBTI_UNKNOWN_HEX}10`,
    alignItems:'center',flexDirection:'row',justifyContent:'center',gap:10,
  },
  unknownText:{fontSize:12,color:'rgba(255,255,255,0.7)',letterSpacing:1.5},
  error:{color:'rgba(255,120,120,0.8)',fontSize:12,marginTop:12,textAlign:'center'},
  btnRowAbs:{
    position:'absolute',left:0,right:0,bottom:0,
    flexDirection:'row',gap:12,
    paddingHorizontal:32,paddingTop:12,
    backgroundColor:'#060608',
    borderTopWidth:0.5,borderTopColor:'rgba(255,255,255,0.05)',
  },
  btnBack:{flex:1,paddingVertical:14,alignItems:'center'},
  btnBackText:{fontSize:12,color:'rgba(255,255,255,0.4)',letterSpacing:2},
  btnNext:{flex:2,paddingVertical:14,borderRadius:14,backgroundColor:'rgba(255,255,255,0.08)',borderWidth:0.5,borderColor:'rgba(255,255,255,0.2)',alignItems:'center'},
  btnNextText:{fontSize:13,color:'white',letterSpacing:2,fontWeight:'500'},
  btnDisabled:{opacity:0.3},
})

const AV=StyleSheet.create({
  wrap:{flex:1,alignItems:'center',gap:28},
  main:{fontSize:20,color:'rgba(255,255,255,0.75)',textAlign:'center',lineHeight:30,letterSpacing:1,fontWeight:'300'},
  dots:{flexDirection:'row',gap:10},
  dot:{width:6,height:6,borderRadius:4,backgroundColor:'rgba(255,255,255,0.7)'},
})

const CV=StyleSheet.create({
  title:{fontSize:22,color:'white',fontWeight:'200',letterSpacing:6,marginBottom:10},
  sub:{fontSize:13,color:'rgba(255,255,255,0.55)',textAlign:'center',lineHeight:22,marginBottom:24},
  cardRow:{flexDirection:'row',gap:8,width:'100%',marginBottom:16},
  card:{flex:1,aspectRatio:1.1,backgroundColor:'rgba(255,255,255,0.04)',borderWidth:0.5,borderColor:'rgba(255,255,255,0.1)',borderRadius:12,alignItems:'center',justifyContent:'center',gap:5},
  cardLabel:{fontSize:9,letterSpacing:2,color:'rgba(255,255,255,0.35)'},
  cardValue:{fontSize:15,color:'white',fontWeight:'400',letterSpacing:1},
  matchWrap:{marginTop:4,alignItems:'center',gap:3,marginBottom:12},
  matchLabel:{fontSize:9,letterSpacing:3,color:'rgba(255,255,255,0.35)'},
  matchValue:{fontSize:28,color:'white',fontWeight:'200',letterSpacing:1},
  summary:{fontSize:12,color:'rgba(255,255,255,0.6)',textAlign:'center',lineHeight:20,marginBottom:20,paddingHorizontal:8},
  btnWrap:{width:'100%',alignItems:'center',marginTop:8},
  btn:{width:'85%',paddingVertical:15,borderRadius:14,backgroundColor:'rgba(255,255,255,0.1)',borderWidth:0.5,borderColor:'rgba(255,255,255,0.25)',alignItems:'center'},
  btnText:{fontSize:13,color:'white',letterSpacing:3,fontWeight:'500'},
})
