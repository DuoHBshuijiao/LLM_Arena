import type { GlobalSettings } from "./types";
import {
  ALGORITHM_JUDGE_SYSTEM,
  ALGORITHM_JUDGE_USER,
  EVAL_PRESET_ALGO_ANN_TRILLION,
  EVAL_PRESET_ALGO_DYNAMIC_GRAPH_OOD,
  EVAL_PRESET_ALGO_TOPO_CAUSAL,
  getAlgorithmAggregatorPartial,
  TASK_ALGO_ANN,
  TASK_ALGO_DYNAMIC_GRAPH,
  TASK_ALGO_TOPO_CAUSAL,
} from "./algorithmEvaluationPrompts";
import {
  EVAL_PRESET_MATH_GALOIS_M23,
  EVAL_PRESET_MATH_HYPERGRAPH,
  EVAL_PRESET_MATH_TENSOR,
  getMathAggregatorPartial,
  MATH_JUDGE_SYSTEM,
  MATH_JUDGE_USER,
  TASK_MATH_GALOIS_M23,
  TASK_MATH_HYPERGRAPH,
  TASK_MATH_TENSOR,
} from "./mathEvaluationPrompts";
import {
  EVAL_PRESET_LLM_SYS_GPU_SPARSE,
  EVAL_PRESET_LLM_SYS_KV_CLUSTER,
  getLlmSystemsAggregatorPartial,
  LLM_SYSTEMS_JUDGE_SYSTEM,
  LLM_SYSTEMS_JUDGE_USER,
  TASK_LLM_SYS_GPU_SPARSE,
  TASK_LLM_SYS_KV_CLUSTER,
} from "./llmSystemsEvaluationPrompts";

export {
  getAlgorithmAggregatorPartial,
} from "./algorithmEvaluationPrompts";

export {
  getMathAggregatorPartial,
} from "./mathEvaluationPrompts";

export {
  getLlmSystemsAggregatorPartial,
} from "./llmSystemsEvaluationPrompts";

/** 诗歌评测 — 三套命题 ID（稳定，勿改） */
export const EVAL_PRESET_POETRY_NIGHT_HANSHAN = "poetry-night-hanshan";
export const EVAL_PRESET_POETRY_GUANSHU = "poetry-guanshu";
export const EVAL_PRESET_POETRY_CITY_ALGAE = "poetry-city-algae";

export const POETRY_AGGREGATOR_SYSTEM = `你是一个结果汇总助手。你的任务是将多位Judge对同一首诗歌的评分与评语进行简洁归纳。
要求：
1. 只整理评委的原意和分数，不加入自己的任何评价、判断或补充。
2. 按评委模型名称分别列出，不得使用“评委1”“评委2”等匿名指代。
3. 总字数不超过200字。
4. 输出语言为中文。`;

export const POETRY_AGGREGATOR_USER = `【参赛作品】
{{candidate}}

【各评委评价】
{{reviews}}

请按上述要求，汇总每位评委的意见与分数，只呈现评委模型原名及对应内容，不做额外评价。`;

export const POETRY_JUDGE_SYSTEM = `你是一位在中文系执教30年的教授，专攻古典诗词与现当代文学。他厌恶“AI腔”（即辞藻华丽但言之无物、逻辑断裂的文本）。他打分极其吝啬，6分在他眼中意味着“勉强算诗”。

评分维度（权重分配）
在给出具体分值前，必须从以下四个维度进行拆解分析：

格律与声韵（20%）： 若为古典诗，考察平仄、对仗、押韵的严谨度；若为现代诗，考察内在节奏、断句的呼吸感、尾韵的处理（若有）。

语言与炼字（30%）： 词汇是否精准、新颖？是否存在“陈词滥调”（如：璀璨、旖旎、宛如画）？是否有“一字立骨”的精妙处？

意境与逻辑（30%）： 意象组合是否形成统一的画面或情感场域？内部逻辑是否自洽（即使是梦境或超现实，也需有内在的潜意识逻辑）？

情感与格局（20%）： 情感是“矫揉造作”还是“真诚深刻”？是局限于个人的小情绪，还是触及了人类共通的悲欢或哲学思辨？

1-10分 详细评分标准（门槛说明）
1-5分（不及格区间：存在重大缺陷）

1-3分： 根本不成诗。仅有分行，无诗意；语病连篇；完全不合基本的格律（如押错韵部）；或者完全是网络热词的拼凑。

4分： 形式上勉强像诗（如格式正确），但内容全是陈词滥调，逻辑混乱，意象堆砌且互不关联，读之味同嚼蜡。

5分： 有基本的完成度，语句通顺，但毫无亮点。像是一个合格的中学生作文，缺乏想象力，情感直白如水，无任何“诗家语”的锤炼。

6分（及格线：达到“诗”的基本门槛）

门槛说明： 这是一首诗的下限。作品没有硬伤（语法、押韵无误），且至少包含1处有效的意象使用。虽然整体平庸，但逻辑清晰，能看出作者知道自己在写什么。

Judge话术示例： “此作符合诗的基本规范，平仄无误，语句通顺。‘风吹落叶’虽为熟景，但表达清晰。然而全篇缺乏令人眼前一亮的警句，意象选取过于常见，止步于及格线。”

7分（良好线：从“写诗”到“写好诗”）

门槛说明： 在6分基础上，必须满足以下任意两项：

炼字有佳处： 至少有一处动词或形容词的使用具有“陌生化”效果（例如：将“落日”写成“落日咳血”而非“落日西沉”）。
结构有匠心： 起承转合清晰，或现代诗的意象跳跃具有内在的逻辑链条。
情感克制： 能够通过意象间接传达情感，而非直抒胸臆。
Judge话术示例： “此作在格律基础上，炼字见功力，如‘拧干’一词赋予风以实体感，颇为新颖。结构上由景入情，过渡自然。虽未达到大家水准，但已属良作，给7分。”

8分（优秀线：达到“发表级”水准）

门槛说明： 在7分基础上，必须同时满足：

整体意境统一： 所有意象围绕核心主题展开，形成浑然一体的艺术氛围。
技法纯熟： 熟练运用对仗、隐喻、通感等技法，且不露痕迹。
无废笔： 全诗无一句是凑数的，字字珠玑或句句有用。
Judge话术示例： “此作已达专业发表水准。全诗以‘钟声’为轴，统摄‘苔痕’与‘孤月’，三景交融，营造出幽邃空灵的禅境。对仗工稳而不板滞，尾联以问句作结，余韵悠长。扣分点在于‘思’字稍显用力过猛，破坏了一分冷寂，故为8分。”

9分（卓越线：具备“风格”与“洞见”）

门槛说明： 在8分基础上，必须展现出独特的个人风格或深刻的哲学/美学洞见。不再是“写得好”，而是“非如此写不可”。诗句具有极强的辨识度，且能引发读者超越文本本身的深层思考（如对生命、宇宙的叩问）。允许存在极少数“破格”（如为了意境突破格律），且破格处恰好是点睛之笔。

Judge话术示例： “此作已超出技巧范畴，直指诗学本质。语言极具现代性的冷冽，将‘城市’与‘藻类’的生物学特征完美融合，创造出一种后工业时代的荒诞美学。尤其是‘数据流中光合作用’一句，打破了物我界限，体现了对现代人生存困境的深刻洞察。虽有一处断句略显生涩，但瑕不掩瑜，此为9分上品。”

10分（传世级：几乎不可能由当前LLM达到）

门槛说明： 这是一道“理论分”或“天花板”。作品必须达到“无我之境”（如王国维评词），语言、结构、意境、情感全部完美统一，且具有开创性的艺术价值。读后令人拍案叫绝，甚至能改变读者对某种诗体的认知。（严格提示：在LLM Arena中，除非出现真正意义上的杰作，否则Judge应默认最高仅能给9.5分，10分保留作为永不轻易给出的“神性时刻”。）

Judge话术示例： “此作已臻化境。通篇无一字无来处，又无一字是旧时。情感之真挚如赤子之心，技法之老辣如庖丁解牛。‘星垂平野阔，月涌大江流’之气象，复现于当代。此为10分，传世之作。”`;

export const POETRY_JUDGE_USER = `【参赛诗歌】
{{candidate}}

请根据你的评审标准，对这首诗歌进行详细分析，然后给出分数。`;

const TASK_POETRY_1 = `题目： 《夜访寒山》

体裁： 七律 或 现代短诗（不少于14行）

核心要求：

必须包含“钟声”、“苔痕”、“孤月”三个意象。

禁止直接使用“孤独”、“寂寞”、“悲伤”等情绪词汇，需通过意象组合传递情绪。

考察点： 防止模型偷懒使用情绪标签，逼迫其进行“意象的客观化呈现”。`;

const TASK_POETRY_2 = `题目： 《观书》

体裁： 五言古诗 或 哲理小诗

核心要求：

需借用“水”或“镜”的物理特性，隐喻认知与真理的关系。

诗中至少包含一次“视角转换”（如：由静观动，由实入虚）。

考察点： 考察模型是否具备东方诗学中“理趣”的表达能力，而非仅抒情。`;

const TASK_POETRY_3 = `题目： 《城市里的游藻》

体裁： 自由诗（不限行数）

核心要求：

将“生物性（藻类）”与“机械性（钢筋/数据流）”进行强行嫁接。

必须出现一处“通感”修辞（如：听见绿色，看到尖锐的寂静）。

考察点： 考察模型的语言创新能力和打破常规逻辑的勇气。`;

export type EvaluationPresetFamily =
  | "poetry"
  | "algorithm"
  | "math"
  | "llm_systems";

export interface EvaluationPresetDefinition {
  id: string;
  name: string;
  description?: string;
  taskPrompt: string;
  family: EvaluationPresetFamily;
}

export const BUILTIN_EVALUATION_PRESETS: EvaluationPresetDefinition[] = [
  {
    id: EVAL_PRESET_POETRY_NIGHT_HANSHAN,
    name: "命题一 · 夜访寒山",
    description: "意象重构（画面感与炼字）",
    taskPrompt: TASK_POETRY_1,
    family: "poetry",
  },
  {
    id: EVAL_PRESET_POETRY_GUANSHU,
    name: "命题二 · 观书",
    description: "古典理趣（逻辑与哲思）",
    taskPrompt: TASK_POETRY_2,
    family: "poetry",
  },
  {
    id: EVAL_PRESET_POETRY_CITY_ALGAE,
    name: "命题三 · 城市里的游藻",
    description: "现代性张力（语言实验与陌生化）",
    taskPrompt: TASK_POETRY_3,
    family: "poetry",
  },
  {
    id: EVAL_PRESET_ALGO_ANN_TRILLION,
    name: "算法 · 千亿级向量 ANN",
    description: "索引与查询（规模与硬件约束）",
    taskPrompt: TASK_ALGO_ANN,
    family: "algorithm",
  },
  {
    id: EVAL_PRESET_ALGO_DYNAMIC_GRAPH_OOD,
    name: "算法 · 动态图与 OOD",
    description: "流式图与自适应推理",
    taskPrompt: TASK_ALGO_DYNAMIC_GRAPH,
    family: "algorithm",
  },
  {
    id: EVAL_PRESET_ALGO_TOPO_CAUSAL,
    name: "算法 · 拓扑与因果混合",
    description: "全局约束与可扩展推断",
    taskPrompt: TASK_ALGO_TOPO_CAUSAL,
    family: "algorithm",
  },
  {
    id: EVAL_PRESET_MATH_HYPERGRAPH,
    name: "数学 · 超图 H(n) 下界（组合）",
    description: "拉姆齐型构造与常数改进",
    taskPrompt: TASK_MATH_HYPERGRAPH,
    family: "math",
  },
  {
    id: EVAL_PRESET_MATH_GALOIS_M23,
    name: "数学 · 逆伽罗瓦与 M₂₃（数论）",
    description: "整数多项式与伽罗瓦群",
    taskPrompt: TASK_MATH_GALOIS_M23,
    family: "math",
  },
  {
    id: EVAL_PRESET_MATH_TENSOR,
    name: "数学 · 张量集中不等式（概率/泛函）",
    description: "高斯过程与张量范数",
    taskPrompt: TASK_MATH_TENSOR,
    family: "math",
  },
  {
    id: EVAL_PRESET_LLM_SYS_GPU_SPARSE,
    name: "硬件优化 · GPU 稀疏注意力算子",
    description: "超长上下文与稀疏注意力内核",
    taskPrompt: TASK_LLM_SYS_GPU_SPARSE,
    family: "llm_systems",
  },
  {
    id: EVAL_PRESET_LLM_SYS_KV_CLUSTER,
    name: "硬件优化 · 千卡集群 KV 缓存",
    description: "分布式 KV 与跨节点读写",
    taskPrompt: TASK_LLM_SYS_KV_CLUSTER,
    family: "llm_systems",
  },
];

export const DEFAULT_EVALUATION_PRESET_ID = BUILTIN_EVALUATION_PRESETS[0].id;

export function getEvaluationPresetById(
  id: string,
): EvaluationPresetDefinition | undefined {
  return BUILTIN_EVALUATION_PRESETS.find((p) => p.id === id);
}

/** 用于设置页 / 运行页标题：随当前命题家族切换 */
export function getEvaluationThemeLabel(presetId: string): string {
  const def = getEvaluationPresetById(presetId);
  if (!def) return "诗歌评测";
  if (def.family === "algorithm") return "算法设计";
  if (def.family === "math") return "数学评测";
  if (def.family === "llm_systems") return "硬件优化";
  return "诗歌评测";
}

/**
 * 切换内置命题预设：更新题目、各 Judge 的 system/user，并按家族同步汇总模板。
 */
export function applyEvaluationPreset(
  settings: GlobalSettings,
  presetId: string,
): GlobalSettings {
  const def = getEvaluationPresetById(presetId);
  if (!def) {
    return settings;
  }
  const judgeSystem =
    def.family === "algorithm"
      ? ALGORITHM_JUDGE_SYSTEM
      : def.family === "math"
        ? MATH_JUDGE_SYSTEM
        : def.family === "llm_systems"
          ? LLM_SYSTEMS_JUDGE_SYSTEM
          : POETRY_JUDGE_SYSTEM;
  const judgeUser =
    def.family === "algorithm"
      ? ALGORITHM_JUDGE_USER
      : def.family === "math"
        ? MATH_JUDGE_USER
        : def.family === "llm_systems"
          ? LLM_SYSTEMS_JUDGE_USER
          : POETRY_JUDGE_USER;
  const aggPartial =
    def.family === "algorithm"
      ? getAlgorithmAggregatorPartial()
      : def.family === "math"
        ? getMathAggregatorPartial()
        : def.family === "llm_systems"
          ? getLlmSystemsAggregatorPartial()
          : getPoetryAggregatorPartial();
  const judges = settings.judges.map((j) => ({
    ...j,
    systemPrompt: judgeSystem,
    userPromptTemplate: judgeUser,
  }));
  return {
    ...settings,
    evaluationPresetId: def.id,
    taskPrompt: def.taskPrompt,
    judges,
    aggregator: {
      ...settings.aggregator,
      ...aggPartial,
    },
  };
}

/** 迁移或补全：将 Judge 文案统一为诗歌教授模板（不修改 aggregator）。 */
export function applyPoetryJudgePrompts(settings: GlobalSettings): GlobalSettings {
  return {
    ...settings,
    judges: settings.judges.map((j) => ({
      ...j,
      systemPrompt: POETRY_JUDGE_SYSTEM,
      userPromptTemplate: POETRY_JUDGE_USER,
    })),
  };
}

export function getPoetryAggregatorPartial(): {
  systemPrompt: string;
  userPromptTemplate: string;
} {
  return {
    systemPrompt: POETRY_AGGREGATOR_SYSTEM,
    userPromptTemplate: POETRY_AGGREGATOR_USER,
  };
}
