import { Keyboard } from "grammy";
import { BUTTONS } from "./constants";

export function createMainKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.presentations)
    .row()
    .text(BUTTONS.leadGeneration)
    .resized()
    .persistent();
}

export function createPresentationKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.createPresentation)
    .row()
    .text(BUTTONS.editPresentation)
    .text(BUTTONS.myPresentations)
    .row()
    .text(BUTTONS.back)
    .resized()
    .persistent();
}
