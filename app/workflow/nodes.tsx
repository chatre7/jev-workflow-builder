"use client";

import {
  Handle,
  Position,
  useNodeConnections,
  useNodesData,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  AlertCircle,
  Bot,
  Check,
  CircleDashed,
  FileOutput,
  FileSpreadsheet,
  GitBranch,
  Globe,
  BookOpen,
  ClipboardCheck,
  Clock3,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Rows3,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FieldLabel, Select, TextArea, TextField } from "./fields";
import { useApprovalExpired, useRun } from "./run-context";
import {
  getRunOutput,
  type Answer,
  type NodeResultData,
  type NodeStatus,
} from "./runs";
import {
  CONDITION_OPERATORS,
  FALSE_HANDLE,
  IN_HANDLE,
  JEV_MODELS,
  LLM_MODEL_GROUPS,
  LLM_MODELS,
  MAX_CSV_ROWS,
  MAX_CSV_COLUMNS,
  MAX_CSV_FIELD_CHARS,
  MAX_CSV_HEADER_CHARS,
  MAX_DATA_SOURCE_CHARS,
  MAX_TRANSFORM_FIELDS,
  TRUE_HANDLE,
  createOutputProperty,
  createQuestion,
  createTransformField,
  getActivation,
  getOutputProperties,
  getOutputPropertyId,
  getSourceHandles,
  slugify,
  truncate,
  type ActivationMode,
  type ConditionNode,
  type CsvNode,
  type HttpNode,
  type ApprovalNode,
  type KnowledgeNode,
  type ConditionOperator,
  type Criterion,
  type HandleDef,
  type InputNode,
  type JevNode,
  type LlmNode,
  type OutputNode,
  type OutputProperty,
  type QuestionDef,
  type QuestionType,
  type TransformField,
  type TransformNode,
  type WorkflowNode,
  type WorkflowEdge,
} from "./shared";

export const NODE_WIDTH = 272;

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  choice: "Choice",
  score: "Score",
  noul: "Yes / no",
};

/* -------------------------------------------------------------------------- */
/*                                   Frame                                    */
/* -------------------------------------------------------------------------- */

function StatusIcon({ status }: { status: NodeStatus | undefined }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 animate-spin text-violet-600" />;
    case "waiting":
      return <Clock3 className="size-3.5 text-amber-700" aria-label="Waiting for approval" />;
    case "complete":
      return <Check className="size-3.5 text-emerald-600" />;
    case "error":
      return <AlertCircle className="size-3.5 text-red-600" />;
    case "skipped":
      return <CircleDashed className="size-3.5 text-neutral-400" />;
    default:
      return null;
  }
}

/**
 * "Runs when" setting for nodes with incoming edges. `all` turns a node with
 * several incoming handles into an AND gate.
 */
function ActivationControl({
  id,
  activation,
  incomingCount,
}: {
  id: string;
  activation: ActivationMode;
  incomingCount: number;
}) {
  const { updateNodeData } = useReactFlow<WorkflowNode>();

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>Runs when</FieldLabel>
      <div className="flex rounded-md bg-neutral-100 p-0.5 text-[11px]">
        {(
          [
            ["any", "Any input fires", "OR"],
            ["all", "All inputs fire", "AND"],
          ] as const
        ).map(([mode, label, short]) => (
          <button
            key={mode}
            type="button"
            onClick={() => updateNodeData(id, { activation: mode })}
            aria-pressed={activation === mode}
            className={`nodrag min-h-7 flex-1 rounded-md px-1.5 py-1 ${
              activation === mode
                ? "bg-white font-medium text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:bg-neutral-100"
            }`}
          >
            {label} <span className="opacity-60">({short})</span>
          </button>
        ))}
      </div>
      {activation === "all" && incomingCount < 2 ? (
        <p className="text-[11px] leading-relaxed text-amber-700">
          Connect two or more handles into this node to make the AND useful.
        </p>
      ) : null}
    </div>
  );
}

function NodeFrame({
  id,
  node,
  selected,
  icon,
  accent,
  result,
  hasTarget,
  handles,
  summary,
  editor,
}: {
  id: string;
  node: WorkflowNode;
  selected: boolean | undefined;
  icon: ReactNode;
  accent: string;
  result: NodeResultData | undefined;
  hasTarget: boolean;
  handles: HandleDef[];
  summary: ReactNode;
  editor: ReactNode;
}) {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const updateNodeInternals = useUpdateNodeInternals();
  const { selectedRunId } = useRun();
  const [isEditing, setEditing] = useState(false);
  const editAreaRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const incoming = useNodeConnections({ id, handleType: "target" });
  const activation = node.type === "input" ? null : getActivation(node.data);
  const handleKey = handles.map((handle) => handle.id).join("|");

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, handleKey, isEditing, updateNodeInternals]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    editAreaRef.current
      ?.querySelector<HTMLElement>("input, textarea, select, button")
      ?.focus({ preventScroll: true });

    const onPointerDown = (event: PointerEvent) => {
      const editArea = editAreaRef.current;

      if (
        !editArea ||
        !(event.target instanceof Node) ||
        editArea.contains(event.target)
      ) {
        return;
      }

      // Fields commit on blur, so save the active draft before unmounting it.
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        editArea.contains(activeElement)
      ) {
        activeElement.blur();
      }

      setEditing(false);
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [isEditing]);

  const fired = new Set(result?.firedHandles ?? []);
  // Dim nodes that a selected run never reached.
  const dimmed = selectedRunId !== null && result === undefined;

  return (
    <div
      className="workflow-node"
      style={{ width: NODE_WIDTH, opacity: dimmed ? 0.45 : 1 }}
      data-selected={selected ? "" : undefined}
      data-status={result?.status}
    >
      {hasTarget && (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id={IN_HANDLE}
            className="workflow-handle"
          />
          {activation === "all" ? (
            <span
              className="absolute -left-2 top-1/2 -translate-x-full -translate-y-1/2 rounded bg-neutral-900 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-white"
              title={`Runs only when all ${incoming.length} incoming handles fire`}
            >
              AND
            </span>
          ) : null}
        </>
      )}

      <div className="workflow-node-header">
        <span
          className="workflow-node-icon"
          style={{ color: accent, background: `${accent}12` }}
        >
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 items-center">
          <TextField
            aria-label="Node name"
            fit
            value={node.data.label}
            onCommit={(label) => updateNodeData(id, { label })}
            className="!border-transparent !bg-transparent !font-semibold hover:!border-neutral-200"
          />
        </div>
        <StatusIcon status={result?.status} />
      </div>

      <div
        ref={editAreaRef}
        className={`workflow-node-body px-2.5 py-2 ${isEditing ? "nodrag nopan" : ""}`}
        data-editing={isEditing ? "" : undefined}
      >
        {!isEditing ? (
          <button
            type="button"
            className="workflow-node-edit-button nodrag nopan"
            aria-label={`Edit ${node.data.label}`}
            aria-expanded={false}
            aria-controls={bodyId}
            onClick={(event) => {
              event.stopPropagation();
              setEditing(true);
            }}
          >
            <Pencil className="size-3" /> Edit
          </button>
        ) : null}
        <div id={bodyId}>
          {isEditing ? (
            <div className="flex flex-col gap-2">
              {editor}
              {activation !== null ? (
                <ActivationControl
                  id={id}
                  activation={activation}
                  incomingCount={incoming.length}
                />
              ) : null}
            </div>
          ) : (
            <div className="workflow-node-summary">{summary}</div>
          )}
        </div>
      </div>

      {result?.error && (
        <div className="mx-3 mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {result.error}
        </div>
      )}

      {handles.length > 0 ? (
        <div className="workflow-node-ports">
          {handles.map((handle) => (
            <div
              key={handle.id}
              className="workflow-node-port relative flex h-6 items-center justify-end pr-2.5"
              data-fired={fired.has(handle.id) ? "" : undefined}
              title={handle.title}
            >
              <span
                className={`truncate text-xs ${
                  fired.has(handle.id)
                    ? "font-medium text-violet-700"
                    : "text-neutral-500"
                }`}
              >
                {handle.questionId ? (
                  <span className="text-neutral-400">
                    {handle.questionId} ·{" "}
                  </span>
                ) : null}
                {handle.label}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={handle.id}
                className="workflow-handle"
                data-fired={fired.has(handle.id) ? "" : undefined}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                 Input node                                 */
/* -------------------------------------------------------------------------- */

const InputNodeView = memo(({ id, data, selected }: NodeProps<InputNode>) => {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const { results } = useRun();
  const result = results.get(id);
  const node: InputNode = { id, type: "input", position: { x: 0, y: 0 }, data };

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<MessageSquareText className="size-3.5" />}
      accent="#171717"
      result={result}
      hasTarget={false}
      handles={getSourceHandles(node)}
      summary={
        <p className="text-xs leading-relaxed text-neutral-600">
          {result
            ? truncate(result.input, 160)
            : data.sample
              ? truncate(data.sample, 160)
              : "Text sent to the workflow. Use the Run button or POST to the API."}
        </p>
      }
      editor={
        <label className="flex flex-col gap-1">
          <FieldLabel>Sample input for test runs</FieldLabel>
          <TextArea
            rows={5}
            value={data.sample}
            placeholder="Paste a sample message…"
            onCommit={(sample) => updateNodeData(id, { sample })}
          />
        </label>
      }
    />
  );
});

/* -------------------------------------------------------------------------- */
/*                                  Jev node                                  */
/* -------------------------------------------------------------------------- */

function AnswerBadge({ answer }: { answer: Answer }) {
  switch (answer.type) {
    case "choice":
      return (
        <span>
          <b className="text-neutral-900">{answer.choice}</b> ·{" "}
          {Math.round((answer.probabilities[answer.choice] ?? 0) * 100)}%
        </span>
      );
    case "score":
      return (
        <span>
          score <b className="text-neutral-900">{answer.score.toFixed(2)}</b> ·
          level {answer.level}
        </span>
      );
    case "noul":
      return (
        <span>
          <b className="text-neutral-900">
            {answer.noul >= answer.threshold ? "yes" : "no"}
          </b>{" "}
          · {Math.round(answer.noul * 100)}%
        </span>
      );
  }
}

function CriteriaEditor({
  items,
  onChange,
  keyPlaceholder,
  addLabel,
  ordered,
}: {
  items: Criterion[];
  onChange: (items: Criterion[]) => void;
  keyPlaceholder: string;
  addLabel: string;
  ordered?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-1">
          {ordered && (
            <span className="w-3 text-right text-[10px] text-neutral-400">
              {index}
            </span>
          )}
          <TextField
            aria-label={keyPlaceholder}
            value={item.key}
            placeholder={keyPlaceholder}
            className="!w-24 shrink-0 font-mono"
            onCommit={(key) =>
              onChange(
                items.map((entry, i) =>
                  i === index ? { ...entry, key: slugify(key) } : entry
                )
              )
            }
          />
          <TextField
            aria-label="Description"
            value={item.description}
            placeholder="Description (optional)"
            onCommit={(description) =>
              onChange(
                items.map((entry, i) =>
                  i === index ? { ...entry, description } : entry
                )
              )
            }
          />
          <button
            type="button"
            aria-label="Remove"
            disabled={items.length <= 2}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            className="nodrag icon-button shrink-0 hover:!text-red-600 disabled:opacity-30"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...items,
            {
              key: ordered
                ? `level_${items.length}`
                : `option_${items.length + 1}`,
              description: "",
            },
          ])
        }
        className="nodrag inline-flex min-h-7 items-center gap-1 self-start rounded-md px-1.5 text-xs text-violet-700 hover:bg-violet-50"
      >
        <Plus className="size-3" /> {addLabel}
      </button>
    </div>
  );
}

function QuestionEditor({
  question,
  onChange,
  onRemove,
}: {
  question: QuestionDef;
  onChange: (question: QuestionDef) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-neutral-200/70 bg-neutral-50/80 p-2">
      <div className="flex items-center gap-1">
        <TextField
          aria-label="Question id"
          value={question.id}
          placeholder="question_id"
          className="!w-24 shrink-0 font-mono"
          onCommit={(id) =>
            onChange({ ...question, id: slugify(id) || question.id })
          }
        />
        <Select
          aria-label="Question type"
          value={question.type}
          onChange={(event) => {
            const type = event.target.value as QuestionType;

            if (type === question.type) {
              return;
            }

            const next = createQuestion(type, 0);
            onChange({
              ...next,
              id: question.id,
              instructions: question.instructions,
            });
          }}
        >
          {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map((type) => (
            <option key={type} value={type}>
              {QUESTION_TYPE_LABELS[type]}
            </option>
          ))}
        </Select>
        <button
          type="button"
          aria-label="Remove question"
          onClick={onRemove}
          className="nodrag icon-button ml-auto shrink-0 hover:!text-red-600"
        >
          <Trash2 className="size-3" />
        </button>
      </div>

      <TextArea
        aria-label="Instructions"
        rows={2}
        value={question.instructions}
        placeholder="Ask one focused question about `input`…"
        onCommit={(instructions) => onChange({ ...question, instructions })}
      />

      {question.type === "choice" && (
        <CriteriaEditor
          items={question.options}
          keyPlaceholder="option"
          addLabel="Add option"
          onChange={(options) => onChange({ ...question, options })}
        />
      )}

      {question.type === "score" && (
        <CriteriaEditor
          items={question.levels}
          keyPlaceholder="level"
          addLabel="Add level"
          ordered
          onChange={(levels) => onChange({ ...question, levels })}
        />
      )}

      {question.type === "noul" && (
        <label className="flex items-center gap-2 text-xs text-neutral-600">
          <span className="shrink-0">
            yes if ≥{" "}
            <b className="font-mono">{question.threshold.toFixed(2)}</b>
          </span>
          <input
            type="range"
            min={0.05}
            max={0.95}
            step={0.05}
            value={question.threshold}
            onChange={(event) =>
              onChange({ ...question, threshold: Number(event.target.value) })
            }
            className="nodrag nopan w-full accent-violet-600"
          />
        </label>
      )}
    </div>
  );
}

const JevNodeView=memo(({ id,data,selected }: NodeProps<JevNode>) => {
  const { updateNodeData }=useReactFlow<WorkflowNode>();
  const { results }=useRun();
  const result=results.get(id);
  const node: JevNode={ id,type: "jev",position: { x: 0,y: 0 },data };
  const modelLabel=
    JEV_MODELS.find((model) => model.id===data.model)?.label??data.model;

  const setQuestions=useCallback(
    (questions: QuestionDef[]) => updateNodeData(id,{ questions }),
    [id,updateNodeData]
  );

  const addQuestion=(type: QuestionType) => {
    const used=new Set(data.questions.map((question) => question.id));
    let index=data.questions.length+1;

    while(used.has(`question_${index}`)) {
      index++;
    }

    setQuestions([...data.questions,createQuestion(type,index)]);
  };

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<Sparkles className="size-3.5" />}
      accent="#7c3aed"
      result={result}
      hasTarget
      handles={getSourceHandles(node)}
      summary={
        <>
          <p className="mb-1.5 text-xs font-medium text-neutral-700">
            {modelLabel}{result?.mock? " · mock":""}
          </p>
          {
            data.questions.length===0? (
              <p className="text-xs text-neutral-400">
                No questions yet. Click Edit to add one.
              </p>
            ):(
              <ul className="flex flex-col gap-1.5">
                {data.questions.map((question) => {
                  const answer=result?.answers?.[question.id];

                  return (
                    <li
                      key={question.id}
                      className="flex items-baseline justify-between gap-2 text-xs"
                    >
                      <span className="truncate">
                        <span className="font-mono text-neutral-700">
                          {question.id}
                        </span>{" "}
                        <span className="text-neutral-400">
                          {QUESTION_TYPE_LABELS[question.type].toLowerCase()}
                        </span>
                      </span>
                      {answer? (
                        <span className="shrink-0 text-neutral-500">
                          <AnswerBadge answer={answer} />
                        </span>
                      ):null}
                    </li>
                  );
                })}
              </ul>
            )
          }
        </>
      }
      editor={
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <FieldLabel>Model</FieldLabel>
            <Select
              value={data.model}
              onChange={(event) => updateNodeData(id,{ model: event.target.value })}
            >
              {!JEV_MODELS.some((model) => model.id===data.model)? (
                <option value={data.model}>{data.model}</option>
              ):null}
              {JEV_MODELS.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </Select>
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Uses OpenRouter credits. Latest can change versions automatically.
          </p>
          <FieldLabel>Questions</FieldLabel>
          {data.questions.map((question,index) => (
            <QuestionEditor
              key={index}
              question={question}
              onChange={(next) =>
                setQuestions(
                  data.questions.map((entry,i) => (i===index? next:entry))
                )
              }
              onRemove={() =>
                setQuestions(data.questions.filter((_,i) => i!==index))
              }
            />
          ))}
          <div className="flex flex-wrap gap-1">
            {(Object.keys(QUESTION_TYPE_LABELS) as QuestionType[]).map(
              (type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addQuestion(type)}
                  className="nodrag inline-flex min-h-7 items-center gap-1 rounded-lg border border-dashed border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:border-violet-400 hover:text-violet-700"
                >
                  <Plus className="size-3" /> {QUESTION_TYPE_LABELS[type]}
                </button>
              )
            )}
          </div>
        </div>
      }
    />
  );
});

/* -------------------------------------------------------------------------- */
/*                                  LLM node                                  */
/* -------------------------------------------------------------------------- */

const LlmNodeView = memo(({ id, data, selected }: NodeProps<LlmNode>) => {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const { results } = useRun();
  const result = results.get(id);
  const node: LlmNode = { id, type: "llm", position: { x: 0, y: 0 }, data };
  const modelLabel =
    LLM_MODELS.find((model) => model.id === data.model)?.label ?? data.model;

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<Bot className="size-3.5" />}
      accent="#0ea5e9"
      result={result}
      hasTarget
      handles={getSourceHandles(node)}
      summary={
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-neutral-500">
            <span className="font-medium text-neutral-700">{modelLabel}</span>
            {result?.mock ? " · mock" : ""}
          </p>
          {result?.output !== undefined && result.status !== "skipped" ? (
            <p className="max-h-24 overflow-hidden whitespace-pre-wrap rounded bg-neutral-50 px-2 py-1 text-xs leading-relaxed text-neutral-700">
              {truncate(result.output, 220)}
              {result.status === "running" ? (
                <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-violet-500 align-middle" />
              ) : null}
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-neutral-500">
              {truncate(data.prompt || "Empty prompt (node is skipped).", 140)}
            </p>
          )}
        </div>
      }
      editor={
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <FieldLabel>Model</FieldLabel>
            <Select
              value={data.model}
              onChange={(event) =>
                updateNodeData(id, { model: event.target.value })
              }
            >
              {!LLM_MODELS.some((model) => model.id === data.model) ? (
                <option value={data.model}>{data.model}</option>
              ) : null}
              {LLM_MODEL_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>System</FieldLabel>
            <TextArea
              rows={2}
              value={data.system}
              placeholder="You are a helpful support agent…"
              onCommit={(system) => updateNodeData(id, { system })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Prompt</FieldLabel>
            <TextArea
              rows={5}
              value={data.prompt}
              placeholder="{{input}}"
              onCommit={(prompt) => updateNodeData(id, { prompt })}
            />
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-400">
            Use <code>{"{{input}}"}</code>, <code>{"{{answers.<id>}}"}</code>,{" "}
            <code>{"{{answers.<id>.probability}}"}</code> and{" "}
            <code>{"{{answers.<id>.confidence}}"}</code>. When several nodes
            connect in, <code>{"{{input}}"}</code> is their texts joined —
            useful for combining drafts before the output node.
          </p>
        </div>
      }
    />
  );
});

/* -------------------------------------------------------------------------- */
/*                              Data-only nodes                               */
/* -------------------------------------------------------------------------- */

function DataSourceHelp({ nodeId }: { nodeId: string }) {
  const incoming = useNodeConnections({ id: nodeId, handleType: "target" });
  const parents = useNodesData<WorkflowNode>(
    [...new Set(incoming.map((connection) => connection.source))]
  );

  return (
    <div className="space-y-1 text-[11px] leading-relaxed text-neutral-500">
      <p>Paths, not templates:</p>
      <ul className="space-y-0.5">
        <li><code>input</code> — joined incoming text</li>
        <li><code>json.amount</code> — a field in valid JSON input</li>
        <li><code className="break-all">{"answers.<id>.confidence"}</code> — an inherited answer</li>
        <li><code className="break-all">{"parents.<node-id>"}</code> — one connected parent&apos;s text</li>
      </ul>
      {parents.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium text-neutral-700">Connected parent paths</p>
          <ul className="space-y-1">
            {parents.map((parent) => (
              <li key={parent.id}>
                <span className="block break-words">{parent.data.label}</span>
                <code className="block cursor-text select-text break-all text-neutral-700">
                  parents.{parent.id}
                </code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p>
        Use <code>json</code> for the whole JSON value. Answer paths also accept{" "}
        <code>value</code> and <code>probability</code>. Missing fields, invalid
        JSON or a parent that did not fire fail the run. JSON paths do not extract
        data from prose.
      </p>
    </div>
  );
}

const ConditionNodeView = memo(
  ({ id, data, selected }: NodeProps<ConditionNode>) => {
    const { updateNodeData } = useReactFlow<WorkflowNode>();
    const { results } = useRun();
    const result = results.get(id);
    const node: ConditionNode = {
      id, type: "condition", position: { x: 0, y: 0 }, data,
    };
    const operatorLabel =
      CONDITION_OPERATORS.find((operator) => operator.id === data.operator)?.label;
    const branch = result?.firedHandles?.find(
      (handle) => handle === TRUE_HANDLE || handle === FALSE_HANDLE
    );

    return (
      <NodeFrame
        id={id}
        node={node}
        selected={selected}
        icon={<GitBranch className="size-3.5" />}
        accent="#d97706"
        result={result}
        hasTarget
        handles={getSourceHandles(node)}
        summary={
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-neutral-500">Compare a value · no AI</p>
            <p className="break-words text-xs leading-relaxed text-neutral-700">
              <code>{truncate(data.source, 60)}</code>{" "}
              {operatorLabel?.toLowerCase()}{" "}
              <code>{data.value === "" ? '""' : truncate(data.value, 60)}</code>
            </p>
            {branch ? (
              <p className="text-xs font-medium text-amber-700">
                Result: {branch} · input passed through
              </p>
            ) : null}
          </div>
        }
        editor={
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <FieldLabel>Source path</FieldLabel>
              <TextField
                value={data.source}
                maxLength={MAX_DATA_SOURCE_CHARS}
                placeholder="json.amount"
                className="font-mono"
                onCommit={(source) => updateNodeData(id, { source })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>Operator</FieldLabel>
              <Select
                value={data.operator}
                onChange={(event) =>
                  updateNodeData(id, {
                    operator: event.target.value as ConditionOperator,
                  })
                }
              >
                {CONDITION_OPERATORS.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>Value</FieldLabel>
              <TextField
                value={data.value}
                placeholder="100"
                onCommit={(value) => updateNodeData(id, { value })}
              />
            </label>
            <p className="text-[11px] leading-relaxed text-neutral-500">
              Text comparisons are exact and case-sensitive. Numeric comparisons
              require decimal numbers. Use <code>true</code>, <code>false</code>{" "}
              or <code>null</code> to match those JSON values. No AI is called;
              only the matching true or false branch receives the original input.
            </p>
            <DataSourceHelp nodeId={id} />
          </div>
        }
      />
    );
  }
);

function TransformFieldEditor({
  field,
  fields,
  onChange,
  onRemove,
}: {
  field: TransformField;
  fields: TransformField[];
  onChange: (changes: Partial<Pick<TransformField, "name" | "source">>) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(field.name);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  useEffect(() => setDraft(field.name), [field.name]);

  function commit(value: string) {
    const name = value.trim();
    let message: string | null = null;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(name)) {
      message = "Use 1–96 letters, digits, underscores or hyphens.";
    } else if (["__proto__", "constructor", "prototype"].includes(name)) {
      message = "This field name is reserved. Choose another name.";
    } else if (fields.some((entry) => entry.id !== field.id && entry.name === name)) {
      message = "This field already exists.";
    }
    setError(message);
    setDraft(message ? field.name : name);
    if (!message && name !== field.name) onChange({ name });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-1">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>Field name</FieldLabel>
          <input
            aria-label={`Field name: ${field.name}`}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            value={draft}
            maxLength={96}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onBlur={(event) => commit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setDraft(field.name);
                event.currentTarget.value = field.name;
                event.currentTarget.blur();
              }
            }}
            spellCheck={false}
            className="workflow-field nodrag nopan min-w-0 w-full rounded-md border border-neutral-200 bg-white px-2 py-1 font-mono text-xs text-neutral-900 focus:border-violet-400 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={onRemove}
          disabled={fields.length <= 1}
          className="icon-button nodrag shrink-0 hover:!text-red-600"
          aria-label={`Remove field ${field.name}`}
          title={fields.length <= 1 ? "Keep at least one field" : "Remove field"}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-[10px] text-red-600">
          {error}
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        <FieldLabel>Source path</FieldLabel>
        <TextField
          aria-label={`Source path for ${field.name}`}
          value={field.source}
          maxLength={MAX_DATA_SOURCE_CHARS}
          placeholder="json.amount"
          className="font-mono"
          onCommit={(source) => onChange({ source })}
        />
      </label>
    </div>
  );
}

const TransformNodeView = memo(
  ({ id, data, selected }: NodeProps<TransformNode>) => {
    const { updateNodeData } = useReactFlow<WorkflowNode>();
    const { results } = useRun();
    const result = results.get(id);
    const node: TransformNode = {
      id, type: "transform", position: { x: 0, y: 0 }, data,
    };

    function addField() {
      if (data.fields.length >= MAX_TRANSFORM_FIELDS) return;
      let index = 1;
      while (data.fields.some((field) => field.name === `field_${index}`)) index++;
      updateNodeData(id, { fields: [...data.fields, createTransformField(index)] });
    }

    return (
      <NodeFrame
        id={id}
        node={node}
        selected={selected}
        icon={<Rows3 className="size-3.5" />}
        accent="#0d9488"
        result={result}
        hasTarget
        handles={getSourceHandles(node)}
        summary={
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-neutral-500">
              Map {data.fields.length} {data.fields.length === 1 ? "field" : "fields"} to JSON · no AI
            </p>
            {result?.output !== undefined && result.status !== "skipped" ? (
              <pre
                aria-label="JSON output preview"
                className="max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded bg-neutral-50 px-2 py-1 font-mono text-xs leading-relaxed text-neutral-700"
              >
                {truncate(result.output, 220)}
              </pre>
            ) : (
              <ul className="space-y-1 text-xs text-neutral-700">
                {data.fields.map((field) => (
                  <li key={field.id} className="break-words">
                    <code>{truncate(field.name, 40)}</code>
                    <span className="text-neutral-500"> from </span>
                    <code>{truncate(field.source, 60)}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        }
        editor={
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-3">
              {data.fields.map((field) => (
                <TransformFieldEditor
                  key={field.id}
                  field={field}
                  fields={data.fields}
                  onChange={(changes) =>
                    updateNodeData(id, {
                      fields: data.fields.map((entry) =>
                        entry.id === field.id ? { ...entry, ...changes } : entry
                      ),
                    })
                  }
                  onRemove={() => {
                    if (data.fields.length <= 1) return;
                    updateNodeData(id, {
                      fields: data.fields.filter((entry) => entry.id !== field.id),
                    });
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addField}
              disabled={data.fields.length >= MAX_TRANSFORM_FIELDS}
              className="nodrag flex min-h-7 items-center justify-center gap-1 rounded-md border border-dashed border-neutral-200 px-2 py-1 text-[11px] text-neutral-500 hover:border-neutral-300 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-3" /> Add field ({data.fields.length}/{MAX_TRANSFORM_FIELDS})
            </button>
            <p className="text-[11px] leading-relaxed text-neutral-500">
              Build a JSON object without AI. JSON selections keep their types;
              input and parent texts remain strings.
            </p>
            <DataSourceHelp nodeId={id} />
          </div>
        }
      />
    );
  }
);

const CsvNodeView = memo(({ id, data, selected }: NodeProps<CsvNode>) => {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const { results } = useRun();
  const result = results.get(id);
  const node: CsvNode = { id, type: "csv", position: { x: 0, y: 0 }, data };
  const delimiterLabel = data.delimiter === "\t"
    ? "Tab"
    : data.delimiter === ";" ? "Semicolon" : "Comma";

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<FileSpreadsheet className="size-3.5" />}
      accent="#0d9488"
      result={result}
      hasTarget
      handles={getSourceHandles(node)}
      summary={
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-neutral-500">CSV to JSON · no AI</p>
          <p className="text-xs text-neutral-700">
            {delimiterLabel} · {data.headers ? "First row headers" : "No headers"}
          </p>
          {result?.csv && result.status !== "skipped" ? (
            <p className="text-xs font-medium text-neutral-700">
              {result.csv.rowCount} {result.csv.rowCount === 1 ? "row" : "rows"} ·{" "}
              {result.csv.columnCount} {result.csv.columnCount === 1 ? "column" : "columns"}
            </p>
          ) : null}
          {result?.output !== undefined && result.status !== "skipped" ? (
            <pre
              aria-label="CSV JSON output preview"
              className="max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded bg-neutral-50 px-2 py-1 font-mono text-xs leading-relaxed text-neutral-700"
            >
              {truncate(result.output, 220)}
            </pre>
          ) : (
            <p className="text-xs leading-relaxed text-neutral-500">
              Connect CSV text from Input or HTTP. Outputs one JSON array.
            </p>
          )}
        </div>
      }
      editor={
        <>
          <label className="flex flex-col gap-1">
            <FieldLabel>Delimiter</FieldLabel>
            <Select
              value={data.delimiter}
              onChange={(event) =>
                updateNodeData(id, { delimiter: event.target.value as CsvNode["data"]["delimiter"] })
              }
            >
              <option value=",">Comma (,)</option>
              <option value=";">Semicolon (;)</option>
              <option value={"\t"}>Tab</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Headers</FieldLabel>
            <Select
              value={data.headers ? "headers" : "none"}
              onChange={(event) => updateNodeData(id, { headers: event.target.value === "headers" })}
            >
              <option value="headers">First row headers</option>
              <option value="none">No headers</option>
            </Select>
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Connect CSV text from Input or HTTP. First row headers produces an array of objects;
            no headers produces an array of string arrays. All cells stay strings:{" "}
            <code>00123</code> stays <code>&quot;00123&quot;</code>. No trimming or formula evaluation.
          </p>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Empty lines are ignored, but whitespace-only lines are data. Quoted delimiters,
            newlines and doubled quotes are supported. Every row must have the same column count.
            Empty input returns <code>[]</code>; a header-only input also returns <code>[]</code>.
          </p>
          <p className="break-words text-[11px] leading-relaxed text-neutral-500">
            Headers are preserved, including Unicode. They must be nonblank and unique;{" "}
            <code>__proto__</code>, <code>constructor</code> and <code>prototype</code> are not allowed.
          </p>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Limits: {MAX_CSV_ROWS} data rows, {MAX_CSV_COLUMNS} columns,{" "}
            {MAX_CSV_FIELD_CHARS} UTF-16 units per cell and {MAX_CSV_HEADER_CHARS} per header.
            Input and JSON output each allow 32,000 UTF-16 units.
            Invalid or oversized CSV fails instead of truncating.
          </p>
        </>
      }
    />
  );
});

/* -------------------------------------------------------------------------- */
/*                              Connected nodes                               */
/* -------------------------------------------------------------------------- */

const HttpNodeView = memo(({ id, data, selected }: NodeProps<HttpNode>) => {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const { results } = useRun();
  const result = results.get(id);
  const node: HttpNode = { id, type: "http", position: { x: 0, y: 0 }, data };

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<Globe className="size-3.5" />}
      accent="#0284c7"
      result={result}
      hasTarget
      handles={getSourceHandles(node)}
      summary={
        <div className="flex flex-col gap-1.5">
          <p className="break-words text-xs font-medium text-neutral-700">
            {data.method} · {data.connection || "Choose a connection"}
          </p>
          <p className="break-all font-mono text-xs text-neutral-500">{truncate(data.path, 100)}</p>
          {result?.httpStatus !== undefined ? (
            <p className="text-xs font-medium text-neutral-700">HTTP {result.httpStatus}</p>
          ) : null}
          {result?.output !== undefined ? (
            <p className="max-h-24 overflow-hidden whitespace-pre-wrap break-words text-xs text-neutral-700">
              {truncate(result.output, 220) || "(empty response)"}
            </p>
          ) : null}
        </div>
      }
      editor={
        <>
          <label className="flex flex-col gap-1">
            <FieldLabel>Connection alias</FieldLabel>
            <TextField value={data.connection} placeholder="support-api" onCommit={(connection) => updateNodeData(id, { connection })} />
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Method</FieldLabel>
            <Select value={data.method} onChange={(event) => updateNodeData(id, { method: event.target.value as "GET" | "POST", body: event.target.value === "GET" ? "" : data.body })}>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Relative path template</FieldLabel>
            <TextField value={data.path} placeholder="tickets?status=open" onCommit={(path) => updateNodeData(id, { path })} />
          </label>
          {data.method === "POST" ? (
            <label className="flex flex-col gap-1">
              <FieldLabel>JSON body template</FieldLabel>
              <TextArea rows={4} value={data.body} placeholder="{{input}}" onCommit={(body) => updateNodeData(id, { body })} />
            </label>
          ) : null}
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Use <code>{"{{input}}"}</code> and <code>{"{{answers.<id>}}"}</code> in the path and body.
            POST bodies must be valid JSON after rendering; leave blank for no body.
            Templates insert raw text. URL-encode query values; use a Transform node followed by{" "}
            <code>{"{{input}}"}</code> to safely build JSON bodies.
          </p>
          <p className="break-words text-[11px] leading-relaxed text-neutral-500">
            An administrator configures aliases, allowed methods and credentials in the server&apos;s{" "}
            <code className="break-all">WORKFLOW_HTTP_CONNECTIONS</code>. Only the alias is stored here.
            Never paste keys into paths or bodies. Requests stay within the configured HTTPS path scope.
          </p>
        </>
      }
    />
  );
});

const ApprovalNodeView = memo(({ id, data, selected }: NodeProps<ApprovalNode>) => {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const { results } = useRun();
  const result = results.get(id);
  const approval = result?.approval;
  const expired = useApprovalExpired(approval?.decision ? undefined : approval?.expiresAt);
  const node: ApprovalNode = { id, type: "approval", position: { x: 0, y: 0 }, data };

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<ClipboardCheck className="size-3.5" />}
      accent="#d97706"
      result={result}
      hasTarget
      handles={getSourceHandles(node)}
      summary={
        <div className="flex flex-col gap-1.5">
          <p className="break-words text-xs leading-relaxed text-neutral-700">
            {truncate(approval?.prompt ?? data.prompt, 180)}
          </p>
          {approval?.decision ? (
            <p className="text-xs font-medium text-neutral-700">
              {approval.decision === "approved" ? "Approved" : "Rejected"} · input passed through
            </p>
          ) : expired ? (
            <p className="text-xs font-medium text-red-700">Approval expired · start a new run</p>
          ) : result?.status === "waiting" ? (
            <p className="text-xs font-medium text-amber-700">Waiting for review in the Runs panel</p>
          ) : (
            <p className="text-xs text-neutral-500">Human review · expires after 24 hours</p>
          )}
          {approval && !approval.decision ? (
            <p className="text-[11px] text-neutral-500">Expires {new Date(approval.expiresAt).toLocaleString()}</p>
          ) : null}
        </div>
      }
      editor={
        <>
          <label className="flex flex-col gap-1">
            <FieldLabel>Review prompt template</FieldLabel>
            <TextArea rows={4} value={data.prompt} placeholder="Review this request: {{input}}" onCommit={(prompt) => updateNodeData(id, { prompt })} />
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Use <code>{"{{input}}"}</code> or <code>{"{{answers.<id>}}"}</code>.
            The owner reviews the prompt and input in the Runs panel. The run pauses durably for up to
            24 hours; expiry never approves it. Approved or rejected sends the original input down that branch.
          </p>
        </>
      }
    />
  );
});

export function KnowledgeResultPreview({ output, compact = false }: { output: string; compact?: boolean }) {
  let matches: { id: string; title: string; excerpt: string; url?: string }[];
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || !("matches" in parsed) || !Array.isArray(parsed.matches)) {
      throw new Error("Invalid search result");
    }
    matches = parsed.matches.slice(0, 5).map((match: unknown) => {
      if (!match || typeof match !== "object" ||
          !("id" in match) || typeof match.id !== "string" ||
          !("title" in match) || typeof match.title !== "string" ||
          !("excerpt" in match) || typeof match.excerpt !== "string") {
        throw new Error("Invalid citation");
      }
      let url: string | undefined;
      if ("url" in match && typeof match.url === "string") {
        try {
          const candidate = new URL(match.url);
          if (candidate.protocol === "https:" && !candidate.username && !candidate.password) url = candidate.href;
        } catch { /* An invalid citation URL is rendered as text only. */ }
      }
      return { id: match.id, title: match.title, excerpt: match.excerpt, url };
    });
  } catch {
    return <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-700">{truncate(output, compact ? 220 : 4000)}</pre>;
  }

  return (
    <div className="space-y-1.5 text-xs">
      <p className="text-neutral-500">{matches.length === 0 ? "No matching documents" : `${matches.length} matching document${matches.length === 1 ? "" : "s"}`}</p>
      <ul className="space-y-2">
        {matches.slice(0, compact ? 2 : 5).map((match, index) => (
          <li key={`${match.id}-${index}`} className="space-y-0.5 break-words">
            <p className="font-medium text-neutral-700">
              {match.url && !compact ? (
                <a href={match.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-violet-700">{truncate(match.title, 240)}</a>
              ) : truncate(match.title, compact ? 70 : 240)}
            </p>
            <p className="text-[11px] text-neutral-500">Citation: <code>{truncate(match.id, 160)}</code></p>
            <p className="whitespace-pre-wrap leading-relaxed text-neutral-700">{truncate(match.excerpt, compact ? 100 : 1200)}</p>
          </li>
        ))}
      </ul>
      {compact && matches.length > 2 ? <p className="text-neutral-500">All citations in the Runs panel</p> : null}
    </div>
  );
}

const KnowledgeNodeView = memo(({ id, data, selected }: NodeProps<KnowledgeNode>) => {
  const { updateNodeData } = useReactFlow<WorkflowNode>();
  const { results } = useRun();
  const result = results.get(id);
  const node: KnowledgeNode = { id, type: "knowledge", position: { x: 0, y: 0 }, data };

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<BookOpen className="size-3.5" />}
      accent="#0d9488"
      result={result}
      hasTarget
      handles={getSourceHandles(node)}
      summary={
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-neutral-500">Up to {data.topK} matches · lexical search · no AI</p>
          {result?.output !== undefined ? (
            <KnowledgeResultPreview output={result.output} compact />
          ) : (
            <p className="break-words text-xs text-neutral-700">{truncate(data.query, 140)}</p>
          )}
        </div>
      }
      editor={
        <>
          <label className="flex flex-col gap-1">
            <FieldLabel>Search query template</FieldLabel>
            <TextArea rows={3} value={data.query} placeholder="{{input}}" onCommit={(query) => updateNodeData(id, { query })} />
          </label>
          <label className="flex flex-col gap-1">
            <FieldLabel>Maximum results</FieldLabel>
            <Select value={data.topK} onChange={(event) => updateNodeData(id, { topK: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{count}</option>)}
            </Select>
          </label>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            Use <code>{"{{input}}"}</code> or <code>{"{{answers.<id>}}"}</code>.
            Searches Thai and English words in the server catalog, without AI or embeddings.
            Results include citation IDs, titles and excerpts; no matches is a valid result.
          </p>
          <p className="text-[11px] leading-relaxed text-neutral-500">
            An administrator sets the catalog path using{" "}
            <code className="break-all">WORKFLOW_KNOWLEDGE_FILE</code> on the server.
            Workflows cannot choose files.
          </p>
        </>
      }
    />
  );
});

/* -------------------------------------------------------------------------- */
/*                                 Output node                                */
/* -------------------------------------------------------------------------- */

function OutputPropertyEditor({
  property,
  properties,
  onRename,
  onRemove,
}: {
  property: OutputProperty;
  properties: OutputProperty[];
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(property.name);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  useEffect(() => setDraft(property.name), [property.name]);

  function commit(value: string) {
    const name = value.trim();
    if (
      !name ||
      properties.some(
        (entry) => entry.id !== property.id && entry.name === name
      )
    ) {
      setError(
        name ? "This property already exists." : "Enter a property name."
      );
      setDraft(property.name);
      return;
    }
    setError(null);
    setDraft(name);
    if (name !== property.name) onRename(name);
  }

  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Left}
        id={property.id}
        className="workflow-handle"
        style={{ left: -10, top: 14 }}
        aria-label={`${property.name} input`}
      />
      <div className="flex items-center gap-1">
        <input
          aria-label={`Property name: ${property.name}`}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setDraft(property.name);
              event.currentTarget.value = property.name;
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
          className="workflow-field nodrag nopan min-w-0 w-full rounded-md border border-neutral-200 bg-white px-2 py-1 font-mono text-xs text-neutral-900 focus:border-violet-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={onRemove}
          className="icon-button nodrag shrink-0 hover:!text-red-600"
          aria-label={`Remove ${property.name}`}
          title="Remove property"
        >
          <Trash2 className="size-3" />
        </button>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-[10px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const OutputNodeView = memo(({ id, data, selected }: NodeProps<OutputNode>) => {
  const { updateNodeData, setEdges } = useReactFlow<
    WorkflowNode,
    WorkflowEdge
  >();
  const { results } = useRun();
  const updateNodeInternals = useUpdateNodeInternals();
  const result = results.get(id);
  const node: OutputNode = {
    id,
    type: "output",
    position: { x: 0, y: 0 },
    data,
  };
  const outputs = getRunOutput(result?.outputs);
  const properties = getOutputProperties(data);
  const propertyKey = properties.map((property) => property.id).join("|");

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, propertyKey, result, updateNodeInternals]);

  function setProperties(next: OutputProperty[]) {
    updateNodeData(id, { properties: next });
  }

  function removeProperty(property: OutputProperty) {
    setEdges((edges) =>
      edges.filter(
        (edge) =>
          edge.target !== id ||
          getOutputPropertyId(edge.targetHandle) !== property.id
      )
    );
    setProperties(properties.filter((entry) => entry.id !== property.id));
  }

  const inputs = (
    <div className="flex flex-col gap-2">
      {properties.length === 0 ? (
        <p className="text-[11px] text-neutral-400">
          Click Edit to add an output property.
        </p>
      ) : null}
      {properties.map((property) => {
        const texts = Object.hasOwn(outputs, property.name)
          ? outputs[property.name]
          : [];
        return (
          <div key={property.id} className="relative min-h-9">
            <Handle
              type="target"
              position={Position.Left}
              id={property.id}
              className="workflow-handle"
              style={{ left: -10, top: 8 }}
              title={property.name}
              aria-label={`${property.name} input`}
            />
            <span className="block text-[11px] font-medium text-neutral-700">
              {property.name}
            </span>
            {texts.length > 0 ? (
              <div className="mt-1 flex flex-col gap-1">
                {texts.map((text, index) => (
                  <p
                    key={index}
                    className="max-h-24 overflow-hidden whitespace-pre-wrap rounded bg-neutral-50 px-2 py-1 text-xs leading-relaxed text-neutral-700"
                  >
                    {truncate(text, 220)}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-[11px] leading-relaxed text-neutral-400">
                {result?.status === "complete"
                  ? "No message"
                  : "Connect a message"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <NodeFrame
      id={id}
      node={node}
      selected={selected}
      icon={<FileOutput className="size-3.5" />}
      accent="#059669"
      result={result}
      hasTarget={false}
      handles={getSourceHandles(node)}
      summary={inputs}
      editor={
        <div className="flex flex-col gap-1.5">
          <FieldLabel>Properties</FieldLabel>
          {properties.map((property) => (
            <OutputPropertyEditor
              key={property.id}
              property={property}
              properties={properties}
              onRename={(name) =>
                setProperties(
                  properties.map((entry) =>
                    entry.id === property.id ? { ...entry, name } : entry
                  )
                )
              }
              onRemove={() => removeProperty(property)}
            />
          ))}
          <button
            type="button"
            onClick={() =>
              setProperties([...properties, createOutputProperty(properties)])
            }
            className="nodrag flex min-h-7 items-center justify-center gap-1 rounded-md border border-dashed border-neutral-200 px-2 py-1 text-[11px] text-neutral-500 hover:border-neutral-300 hover:text-neutral-800"
          >
            <Plus className="size-3" /> Add property
          </button>
        </div>
      }
    />
  );
});

export const nodeTypes: NodeTypes = {
  input: InputNodeView,
  jev: JevNodeView,
  llm: LlmNodeView,
  condition: ConditionNodeView,
  transform: TransformNodeView,
  csv: CsvNodeView,
  http: HttpNodeView,
  approval: ApprovalNodeView,
  knowledge: KnowledgeNodeView,
  output: OutputNodeView,
};
