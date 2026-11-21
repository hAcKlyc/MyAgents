import type {
  ElicitationContentValue,
  ElicitationSchema,
} from "@agentclientprotocol/sdk/unstable";
import type {
  AskUserQuestion,
  AskUserQuestionAnswers,
} from "../../shared/types/askUserQuestion";

export function antigravityForm(schema: ElicitationSchema, message: string) {
  const fields = Object.entries(schema.properties ?? {});
  if (!fields.length) return null;
  const questions: AskUserQuestion[] = [];
  const choices = new Map<string, Map<string, ElicitationContentValue>>();
  for (const [id, field] of fields) {
    // Only advertise shapes for which the existing question card can round-trip
    // every answer. Defer constrained text, URL and array forms to the agent.
    if (field.type !== "string" && field.type !== "boolean") return null;
    if (
      Object.keys(field).some(
        (key) =>
          ![
            "type",
            "title",
            "description",
            "enum",
            "oneOf",
            "_meta",
            "default",
          ].includes(key),
      )
    )
      return null;
    const values = new Map<string, ElicitationContentValue>();
    const options: AskUserQuestion["options"] = [];
    if (field.type === "boolean") {
      for (const value of [true, false]) {
        values.set(String(value), value);
        options.push({ label: String(value), description: "" });
      }
    } else if ("oneOf" in field && Array.isArray(field.oneOf)) {
      for (const option of field.oneOf) {
        if (
          !option ||
          typeof option.const !== "string" ||
          typeof option.title !== "string" ||
          values.has(option.title)
        )
          return null;
        values.set(option.title, option.const);
        options.push({
          label: option.title,
          description: option.description ?? "",
        });
      }
    } else if ("enum" in field && Array.isArray(field.enum)) {
      for (const value of field.enum) {
        if (typeof value !== "string") return null;
        values.set(value, value);
        options.push({ label: value, description: "" });
      }
    }
    const title = typeof field.title === "string" ? field.title : id;
    questions.push({
      id,
      header: title,
      question:
        typeof field.description === "string"
          ? field.description
          : title === id
            ? message
            : title,
      options,
      multiSelect: false,
      allowCustom: options.length === 0,
      required: schema.required?.includes(id) ?? false,
    });
    choices.set(id, values);
  }
  return {
    questions,
    decode(answers: AskUserQuestionAnswers) {
      const content: Record<string, ElicitationContentValue> =
        Object.create(null);
      for (const q of questions) {
        const id = q.id!;
        const answer = answers[id];
        const value =
          typeof answer === "string"
            ? answer
            : answer?.custom || answer?.selected[0];
        if (value === undefined || value === "") {
          if (q.required) throw new Error("请回答必填问题");
          continue;
        }
        const options = choices.get(id)!;
        if (options.size && !options.has(value))
          throw new Error("请选择 Antigravity 提供的选项");
        content[id] = options.get(value) ?? value;
      }
      return content;
    },
  };
}
