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
    .row()
    .text(BUTTONS.advancedEditPresentation)
    .row()
    .text(BUTTONS.myPresentations)
    .row()
    .text(BUTTONS.back)
    .resized()
    .persistent();
}

export function createPresentationSelectionKeyboard(records: Array<{ id: string }>): Keyboard {
  const keyboard = new Keyboard();
  for (const [index, record] of records.slice(0, 12).entries()) {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(`ID ${record.id}`);
  }
  return keyboard.row().text(BUTTONS.advancedDone).resized();
}

export function createAdvancedSectionKeyboard(): Keyboard {
  const keyboard = new Keyboard();
  for (let page = 1; page <= 8; page += 1) {
    keyboard.text(`Раздел ${page}`);
    if (page % 2 === 0) keyboard.row();
  }
  return keyboard.text(BUTTONS.advancedDone).resized();
}

export function createAdvancedFieldKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.advancedHeading)
    .text(BUTTONS.advancedText)
    .row()
    .text(BUTTONS.advancedImage)
    .row()
    .text(BUTTONS.advancedClearSection)
    .row()
    .text(BUTTONS.advancedBackToSections)
    .text(BUTTONS.advancedDone)
    .resized();
}

export function createAdvancedValueKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.advancedClearValue)
    .row()
    .text(BUTTONS.advancedBackToFields)
    .text(BUTTONS.advancedDone)
    .resized();
}

export function createAiBloggersKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.aiBloggersYes)
    .row()
    .text(BUTTONS.aiBloggersNo)
    .row()
    .text(BUTTONS.back)
    .resized();
}

export function createLeadResultKeyboard(): Keyboard {
  return new Keyboard()
    .text(BUTTONS.presentationsFromLeads)
    .row()
    .text(BUTTONS.presentations)
    .text(BUTTONS.leadGeneration)
    .resized()
    .persistent();
}
