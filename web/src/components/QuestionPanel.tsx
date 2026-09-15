import { For } from "solid-js"
import type { QuestionRequest } from "../types"

interface QuestionPanelProps {
  request: QuestionRequest
  onReply: (requestId: string, answers: string[][], rejected?: boolean) => Promise<void>
}

export function QuestionPanel(props: QuestionPanelProps) {
  let form: HTMLFormElement | undefined

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!form) return
    const answers = props.request.questions.map((_, index) => {
      const selected = [...form!.querySelectorAll<HTMLInputElement>(`[name="question-${index}"]:checked`)].map((input) => input.value)
      const custom = form!.querySelector<HTMLInputElement>(`[name="custom-${index}"]`)?.value.trim()
      return custom ? [...selected, custom] : selected
    })
    void props.onReply(props.request.requestId, answers)
  }

  return (
    <section class="question-panel">
      <form ref={form} onSubmit={submit}>
        <For each={props.request.questions}>{(question, questionIndex) => (
          <fieldset>
            <legend>{question.question}</legend>
            <For each={question.options}>{(option) => (
              <label>
                <input type={question.multiple ? "checkbox" : "radio"} name={`question-${questionIndex()}`} value={option.label} />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>
            )}</For>
            {question.custom && <input class="question-custom" name={`custom-${questionIndex()}`} placeholder="Custom answer" />}
          </fieldset>
        )}</For>
        <div class="question-actions">
          <button type="button" onClick={() => void props.onReply(props.request.requestId, [], true)}>Dismiss</button>
          <button type="submit">Continue</button>
        </div>
      </form>
    </section>
  )
}
