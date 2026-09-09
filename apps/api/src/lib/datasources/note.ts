import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

import { hash } from '../utils/hash';
import { actingTeamFilter } from './dataloaders';

type NotesDataloaderKey = {
  referenceId: string;
  noteType: db.NoteType;
};

type NotesDataloader = Dataloader<NotesDataloaderKey, db.Note[]>;

function getNotesByReferenceIdAndTypeDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<NotesDataloaderKey, db.Note[], string>,
): NotesDataloader {
  return new Dataloader(async (keys) => {
    const referenceIds = keys.map((key) => key.referenceId);
    const noteTypes = keys
      .map((key) => key.noteType)
      .filter((value, index, self) => self.indexOf(value) === index);

    const notes = await prisma.note.findMany({
      where: {
        teamId: actingTeamFilter(),
        referenceId: { in: referenceIds },
        noteType: { in: noteTypes },
      },
    });

    const groupedNotes = notes.reduce((acc, note) => {
      const key = hash<NotesDataloaderKey>({
        referenceId: note.referenceId,
        noteType: note.noteType,
      });
      acc.set(key, [...(acc.get(key) ?? []), note]);
      return acc;
    }, new Map());

    return keys.map((key) => groupedNotes.get(hash<NotesDataloaderKey>(key)) ?? []);
  }, dataloaderOptions);
}

export { getNotesByReferenceIdAndTypeDataloader };
