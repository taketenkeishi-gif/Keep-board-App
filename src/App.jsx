import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const STORAGE_KEY = "keep-board-mvp-v2";
const THEME_KEY = "keep-board-theme";
const SETTINGS_KEY = "keep-board-settings";
const MIN_CARD_SPAN = 3;
const MAX_CARD_SPAN = 10;
const MIN_CARD_ROWS = 3;
const MAX_CARD_ROWS = 10;
const BOARD_UNIT = 68;
const BOARD_ROW = 44;
const BOARD_GAP = 16;
const BOARD_CANVAS_WIDTH = 1320;
const BOARD_DROP_STEP = 20;
const BOARD_ZOOM_MIN = 0.67;
const BOARD_ZOOM_MAX = 3;
const SWAP_OVERLAP_RATIO = 0.38;

const defaultSettings = {
  fontSize: 15,
  sortMode: "manual",
  boardZoom: 1,
  appBackgroundMode: "theme",
  appBackgroundColor: "",
  appBackgroundImage: "",
  topbarBackgroundMode: "theme",
  topbarBackgroundColor: "",
  topbarBackgroundImage: "",
};

const itemLabels = {
  note: "メモ",
  image: "画像",
  video: "動画",
  link: "リンク",
  board: "ボード",
  todo: "To-do",
  comment: "コメント",
  column: "Column",
  table: "Table",
  draw: "Draw",
  "shape-line": "Line",
  "shape-rect": "Rect",
  "shape-circle": "Circle",
};

function now() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function createInitialState() {
  const createdAt = now();
  const firstBoardId = createId("board");
  return {
    boards: [
      {
        id: firstBoardId,
        title: "最初のボード",
        parentBoardId: null,
        createdAt,
        updatedAt: createdAt,
        order: 0,
      },
    ],
    items: [
      {
        id: createId("item"),
        boardId: firstBoardId,
        type: "note",
        title: "メモを追加",
        content: "追加ボタンからメモ、画像、リンク、サブボードを配置できます。",
        imagePath: "",
        url: "",
        linkedBoardId: "",
        order: 0,
        createdAt,
        updatedAt: createdAt,
      },
    ],
  };
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("keep-board-mvp-v1");
  if (!saved) return createInitialState();

  try {
    return JSON.parse(saved);
  } catch {
    return createInitialState();
  }
}

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return defaultSettings;
  }
}

function sortByOrder(a, b) {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt);
}

function sortRecords(records, sortMode) {
  const copy = [...records];
  if (sortMode === "title") {
    return copy.sort((a, b) => (a.title || "").localeCompare(b.title || "", "ja"));
  }
  if (sortMode === "newest") {
    return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  if (sortMode === "oldest") {
    return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return copy.sort(sortByOrder);
}

function normalizeOrders(records) {
  const updatedAt = now();
  return records.map((record, index) => ({ ...record, order: index, updatedAt }));
}

function save(nextState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  return nextState;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function probeMediaDimensions(source, type = "image") {
  return new Promise((resolve) => {
    if (!source) {
      resolve({ width: 0, height: 0 });
      return;
    }

    if (type === "video") {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.src = source;
      video.onloadedmetadata = () => resolve({ width: video.videoWidth || 0, height: video.videoHeight || 0 });
      video.onerror = () => resolve({ width: 0, height: 0 });
      return;
    }

    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = source;
  });
}

function getAspectBasedCardSize(width, height, fallbackType) {
  if (!width || !height) {
    return {
      widthUnits: fallbackType === "image" || fallbackType === "video" ? 4 : 2,
      heightUnits: fallbackType === "image" || fallbackType === "video" ? 4 : 2,
      aspectRatio: 1,
    };
  }

  const ratio = width / height;
  const widthUnits = clamp(Math.round(clamp(ratio * 4.2, 3, 8)), MIN_CARD_SPAN, MAX_CARD_SPAN);
  const pixelWidth = widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP;
  const pixelHeight = pixelWidth / Math.max(ratio, 0.2);
  const heightUnits = clamp(
    Math.round((pixelHeight + BOARD_GAP) / (BOARD_ROW + BOARD_GAP)),
    MIN_CARD_ROWS,
    MAX_CARD_ROWS,
  );
  return { widthUnits, heightUnits, aspectRatio: ratio };
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [currentBoardId, setCurrentBoardId] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "light");
  const [settings, setSettings] = useState(loadSettings);
  const [activeCaptionId, setActiveCaptionId] = useState(null);
  const [lightboxId, setLightboxId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const clipboardRef = useRef([]);

  const currentBoard = state.boards.find((board) => board.id === currentBoardId) || null;
  const rootBoards = useMemo(
    () => state.boards.filter((board) => board.parentBoardId === null).sort(sortByOrder),
    [state.boards],
  );
  const boardItems = useMemo(
    () => state.items.filter((item) => item.boardId === currentBoardId).sort(sortByOrder),
    [currentBoardId, state.items],
  );
  const visibleRootBoards = useMemo(
    () => sortRecords(rootBoards.filter((board) => matchesSearch(board, query)), settings.sortMode),
    [query, rootBoards, settings.sortMode],
  );
  const visibleBoardItems = useMemo(
    () =>
      sortRecords(
        boardItems.filter((item) => matchesSearch(item, query) && matchesLabel(item, selectedLabels)),
        settings.sortMode,
      ),
    [boardItems, query, selectedLabels, settings.sortMode],
  );
  const boardLabels = useMemo(
    () => [...new Set(boardItems.map((item) => item.label).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")),
    [boardItems],
  );
  const visibleImages = visibleBoardItems.filter(
    (item) => (item.type === "image" || item.type === "video") && item.imagePath,
  );
  const lightboxIndex = visibleImages.findIndex((item) => item.id === lightboxId);
  const lightboxItem = lightboxIndex >= 0 ? visibleImages[lightboxIndex] : null;
  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--base-font-size", `${settings.fontSize}px`);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setSelectedItemIds([]);
    setActiveCaptionId(null);
  }, [currentBoardId]);

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;

      if (event.key === "Escape" && currentBoard) {
        event.preventDefault();
        setCurrentBoardId(currentBoard.parentBoardId || null);
        setContextMenu(null);
        setIsAddMenuOpen(false);
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        if ((event.key === "Delete" || event.key === "Backspace") && selectedItemIds.length) {
          event.preventDefault();
          deleteItemsByIds(selectedItemIds);
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undoState();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redoState();
      } else if (key === "d") {
        event.preventDefault();
        duplicateSelectedItems();
      } else if (key === "x") {
        event.preventDefault();
        cutSelectedItems();
      } else if (key === "v") {
        event.preventDefault();
        pasteClipboardItems();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentBoard, selectedItemIds, state]);

  const appShellStyle = buildSurfaceStyle(
    settings.appBackgroundMode,
    settings.appBackgroundColor,
    settings.appBackgroundImage,
    "var(--paper)",
  );
  const topbarStyle = buildSurfaceStyle(
    settings.topbarBackgroundMode,
    settings.topbarBackgroundColor,
    settings.topbarBackgroundImage,
    "var(--glass)",
  );

  function updateState(recipe, options = { recordHistory: true }) {
    setState((previous) => {
      const next = recipe(previous);
      if (next === previous) return previous;
      if (options.recordHistory) {
        undoStackRef.current.push(previous);
        if (undoStackRef.current.length > 60) undoStackRef.current.shift();
        redoStackRef.current = [];
      }
      return save(next);
    });
  }

  function undoState() {
    setState((previous) => {
      const snapshot = undoStackRef.current.pop();
      if (!snapshot) return previous;
      redoStackRef.current.push(previous);
      return save(snapshot);
    });
  }

  function redoState() {
    setState((previous) => {
      const snapshot = redoStackRef.current.pop();
      if (!snapshot) return previous;
      undoStackRef.current.push(previous);
      return save(snapshot);
    });
  }

  function getDescendantBoardIds(boardId, boards = state.boards) {
    return boards
      .filter((board) => board.parentBoardId === boardId)
      .flatMap((board) => [board.id, ...getDescendantBoardIds(board.id, boards)]);
  }

  function getBoardPath(board) {
    const path = [];
    let cursor = board;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentBoardId
        ? state.boards.find((candidate) => candidate.id === cursor.parentBoardId)
        : null;
    }
    return path;
  }

  function createBoard(title, parentBoardId = currentBoardId) {
    const values = typeof title === "string" ? { title } : title;
    const createdAt = now();
    updateState((previous) => ({
      ...previous,
      boards: [
        ...previous.boards,
        {
          id: createId("board"),
          title: values.title,
          parentBoardId,
          fontColor: values.fontColor || "",
          fontWeight: values.fontWeight || "700",
          thumbnailImage: values.thumbnailImage || "",
          createdAt,
          updatedAt: createdAt,
          order: previous.boards.filter((board) => board.parentBoardId === parentBoardId).length,
        },
      ],
    }));
  }

  function updateBoard(boardId, title) {
    const values = typeof title === "string" ? { title } : title;
    updateState((previous) => ({
      ...previous,
      boards: previous.boards.map((board) =>
        board.id === boardId ? { ...board, ...values, updatedAt: now() } : board,
      ),
      items: previous.items.map((item) =>
        item.linkedBoardId === boardId ? { ...item, title: values.title, updatedAt: now() } : item,
      ),
    }));
  }

  function createSubBoard() {
    const createdAt = now();
    const boardId = createId("board");
    const order = boardItems.length;
    updateState((previous) => ({
      ...previous,
      boards: [
        ...previous.boards,
        {
          id: boardId,
          title: "新しいサブボード",
          parentBoardId: currentBoardId,
          fontColor: "",
          fontWeight: "700",
          thumbnailImage: "",
          createdAt,
          updatedAt: createdAt,
          order,
        },
      ],
      items: [
        ...previous.items,
        {
          id: createId("item"),
          boardId: currentBoardId,
          type: "board",
          title: "新しいサブボード",
          content: "",
          imagePath: "",
          url: "",
          linkedBoardId: boardId,
          widthUnits: 2,
          heightUnits: 3,
          order,
          createdAt,
          updatedAt: createdAt,
        },
      ],
    }));
  }

  function createQuickItem(type, position = null) {
    const createdAt = now();
    const templates = {
      note: { title: "新しいメモ", content: "", widthUnits: 3, heightUnits: 3 },
      link: { title: "新しいリンク", content: "", url: "https://", widthUnits: 3, heightUnits: 2 },
      todo: { title: "To-do", content: "・やること", widthUnits: 3, heightUnits: 3 },
      comment: { title: "Comment", content: "コメントを書く", widthUnits: 3, heightUnits: 2 },
      column: { title: "Column", content: "見出し\n本文", widthUnits: 4, heightUnits: 5 },
      table: { title: "Table", content: "項目 | 内容\n--- | ---", widthUnits: 4, heightUnits: 4 },
      "shape-line": { title: "Line", content: "", widthUnits: 4, heightUnits: 1, sticker: true },
      "shape-rect": { title: "Rect", content: "", widthUnits: 3, heightUnits: 3, sticker: true },
      "shape-circle": { title: "Circle", content: "", widthUnits: 3, heightUnits: 3, sticker: true },
    };
    const base = templates[type];
    if (!base) return;

    updateState((previous) => ({
      ...previous,
      items: [
        ...previous.items,
        {
          id: createId("item"),
          boardId: currentBoardId,
          linkedBoardId: "",
          order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length,
          createdAt,
          updatedAt: createdAt,
          x: position?.x,
          y: position?.y,
          type,
          url: "",
          imagePath: "",
          label: "",
          ...base,
        },
      ],
    }));
  }

  async function saveItem(type, values, item = null) {
    const createdAt = now();
    const imagePath = values.imageFile?.size
      ? await readImageFile(values.imageFile)
      : item?.imagePath || "";
    const dimensions =
      type === "image" || type === "video"
        ? await probeMediaDimensions(imagePath, type)
        : { width: 0, height: 0 };
    const mediaSize = getAspectBasedCardSize(dimensions.width, dimensions.height, type);

    updateState((previous) => {
      const record = {
        title: values.title,
        content: values.content,
        label: values.label,
        imagePath,
        url: values.url,
        aspectRatio: mediaSize.aspectRatio,
        ...(type === "image" || type === "video" ? mediaSize : {}),
        updatedAt: now(),
      };

      if (item) {
        return {
          ...previous,
          items: previous.items.map((candidate) =>
            candidate.id === item.id ? { ...candidate, ...record } : candidate,
          ),
        };
      }

      return {
        ...previous,
        items: [
          ...previous.items,
          {
            id: createId("item"),
            boardId: currentBoardId,
            type,
            linkedBoardId: "",
            widthUnits: type === "image" || type === "video" ? 4 : 2,
            heightUnits: type === "image" || type === "video" ? 4 : 2,
            order: boardItems.length,
            createdAt,
            ...record,
          },
        ],
      };
    });
  }

  function addDroppedItem(item, dropPosition = null) {
    const createdAt = now();
    updateState((previous) => ({
      ...previous,
      items: [
        ...previous.items,
        {
          id: createId("item"),
          boardId: currentBoardId,
          linkedBoardId: "",
          widthUnits: item.widthUnits || (item.type === "image" || item.type === "video" ? 4 : 2),
          heightUnits: item.heightUnits || (item.type === "image" || item.type === "video" ? 4 : 2),
          x: dropPosition?.x,
          y: dropPosition?.y,
          order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length,
          createdAt,
          updatedAt: createdAt,
          ...item,
        },
      ],
    }));
  }

  function deleteBoard(boardId, skipConfirm = false) {
    if (!skipConfirm && !confirm("このボードと中身を削除しますか？")) return;

    updateState((previous) => {
      const ids = new Set([boardId, ...getDescendantBoardIds(boardId, previous.boards)]);

      return {
        boards: previous.boards.filter((board) => !ids.has(board.id)),
        items: previous.items.filter(
          (item) => !ids.has(item.boardId) && !ids.has(item.linkedBoardId),
        ),
      };
    });

    if (boardId === currentBoardId) {
      setCurrentBoardId(null);
    }
  }

  function deleteItem(item) {
    if (item.type === "board") {
      deleteBoard(item.linkedBoardId, true);
      return;
    }

    updateState((previous) => {
      const remainingItems = previous.items.filter((candidate) => candidate.id !== item.id);
      const normalized = normalizeOrders(
        remainingItems.filter((candidate) => candidate.boardId === item.boardId).sort(sortByOrder),
      );
      const normalizedById = new Map(normalized.map((candidate) => [candidate.id, candidate]));
      return {
        ...previous,
        items: remainingItems.map((candidate) => normalizedById.get(candidate.id) || candidate),
      };
    });
  }

  function handleHomeDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    updateState((previous) => {
      const ordered = previous.boards
        .filter((board) => board.parentBoardId === null)
        .sort(sortByOrder);
      const oldIndex = ordered.findIndex((board) => board.id === active.id);
      const newIndex = ordered.findIndex((board) => board.id === over.id);
      const reordered = normalizeOrders(arrayMove(ordered, oldIndex, newIndex));
      const reorderedById = new Map(reordered.map((board) => [board.id, board]));
      return {
        ...previous,
        boards: previous.boards.map((board) => reorderedById.get(board.id) || board),
      };
    });
  }

  function handleItemDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    updateState((previous) => {
      const ordered = previous.items
        .filter((item) => item.boardId === currentBoardId)
        .sort(sortByOrder);
      const activeItem = ordered.find((item) => item.id === active.id);
      const overItem = ordered.find((item) => item.id === over.id);

      if (activeItem && overItem?.type === "board") {
        const targetBoardId = overItem.linkedBoardId;
        const activeBoardId = activeItem.linkedBoardId;
        const isMovingBoardIntoItself =
          activeItem.type === "board" &&
          (activeBoardId === targetBoardId ||
            getDescendantBoardIds(activeBoardId, previous.boards).includes(targetBoardId));

        if (!isMovingBoardIntoItself) {
          return {
            ...previous,
            items: previous.items.map((item) =>
              item.id === activeItem.id
                ? {
                    ...item,
                    boardId: targetBoardId,
                    order: previous.items.filter((candidate) => candidate.boardId === targetBoardId).length,
                    updatedAt: now(),
                  }
                : item,
            ),
            boards:
              activeItem.type === "board"
                ? previous.boards.map((board) =>
                    board.id === activeItem.linkedBoardId
                      ? { ...board, parentBoardId: targetBoardId, updatedAt: now() }
                      : board,
                  )
                : previous.boards,
          };
        }
      }

      const oldIndex = ordered.findIndex((item) => item.id === active.id);
      const newIndex = ordered.findIndex((item) => item.id === over.id);
      const reordered = normalizeOrders(arrayMove(ordered, oldIndex, newIndex));
      const reorderedById = new Map(reordered.map((item) => [item.id, item]));
      return {
        ...previous,
        items: previous.items.map((item) => reorderedById.get(item.id) || item),
      };
    });
  }

  function resizeMediaItem(itemId, nextSpan, nextRows) {
    const widthUnits = Math.min(MAX_CARD_SPAN, Math.max(MIN_CARD_SPAN, nextSpan));
    const heightUnits = Math.min(MAX_CARD_ROWS, Math.max(MIN_CARD_ROWS, nextRows));
    updateState((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.id === itemId ? { ...item, widthUnits, heightUnits, updatedAt: now() } : item,
      ),
    }));
  }

  function moveItemsOnBoard(itemIds, positions) {
    updateState((previous) => {
      const boardItemsForLayout = previous.items.filter((item) => item.boardId === currentBoardId);
      const positioned = boardItemsForLayout.map((item, index) => {
        const base = withDefaultPosition(item, index);
        if (!positions[item.id]) return base;
        return {
          ...base,
          x: positions[item.id].x,
          y: positions[item.id].y,
          originX: base.x,
          originY: base.y,
          updatedAt: now(),
        };
      });
      const resolved = resolveBoardPlacement(positioned, itemIds);
      const resolvedById = new Map(resolved.map((item) => [item.id, item]));
      return {
        ...previous,
        items: previous.items.map((item) => resolvedById.get(item.id) || item),
      };
    });
  }

  function moveItemToBoard(item, targetBoardId) {
    const activeBoardId = item.linkedBoardId;
    const invalidMove =
      item.type === "board" &&
      (activeBoardId === targetBoardId || getDescendantBoardIds(activeBoardId).includes(targetBoardId));

    if (invalidMove) return;

    updateState((previous) => ({
      ...previous,
      items: previous.items.map((candidate) =>
        candidate.id === item.id
          ? {
              ...candidate,
              boardId: targetBoardId,
              x: undefined,
              y: undefined,
              order: previous.items.filter((target) => target.boardId === targetBoardId).length,
              updatedAt: now(),
            }
          : candidate,
      ),
      boards:
        item.type === "board"
          ? previous.boards.map((board) =>
              board.id === item.linkedBoardId
                ? { ...board, parentBoardId: targetBoardId, updatedAt: now() }
                : board,
            )
          : previous.boards,
    }));
  }

  function duplicateSelectedItems(itemIds = selectedItemIds) {
    if (!currentBoardId || !itemIds.length) return;
    updateState((previous) => {
      const selected = previous.items
        .filter((item) => item.boardId === currentBoardId && itemIds.includes(item.id) && item.type !== "board")
        .map((item, index) => {
          const position = clampPosition(item, { x: (item.x || 0) + 40, y: (item.y || 0) + 40 + index * 10 });
          return {
            ...item,
            id: createId("item"),
            x: position.x,
            y: position.y,
            createdAt: now(),
            updatedAt: now(),
            order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length + index,
          };
        });

      if (!selected.length) return previous;
      return {
        ...previous,
        items: [...previous.items, ...selected],
      };
    });
  }

  function deleteItemsByIds(itemIds) {
    if (!itemIds.length) return;
    updateState((previous) => {
      const selectedIds = new Set(itemIds);
      const boardIdsToDelete = new Set(
        previous.items.filter((item) => selectedIds.has(item.id) && item.type === "board").map((item) => item.linkedBoardId),
      );
      const allBoardIds = new Set(
        [...boardIdsToDelete].flatMap((boardId) => [boardId, ...getDescendantBoardIds(boardId, previous.boards)]),
      );

      return {
        boards: previous.boards.filter((board) => !allBoardIds.has(board.id)),
        items: previous.items.filter(
          (item) => !selectedIds.has(item.id) && !allBoardIds.has(item.boardId) && !allBoardIds.has(item.linkedBoardId),
        ),
      };
    });
    setSelectedItemIds([]);
  }

  function cutSelectedItems() {
    const selected = state.items
      .filter((item) => item.boardId === currentBoardId && selectedItemIds.includes(item.id) && item.type !== "board")
      .map((item) => ({ ...item }));
    if (!selected.length) return;
    const minX = Math.min(...selected.map((item) => item.x || 0));
    const minY = Math.min(...selected.map((item) => item.y || 0));
    clipboardRef.current = selected.map((item) => ({
      ...item,
      x: (item.x || 0) - minX,
      y: (item.y || 0) - minY,
    }));
    deleteItemsByIds(selected.map((item) => item.id));
  }

  function pasteClipboardItems() {
    if (!currentBoardId || !clipboardRef.current.length) return;
    updateState((previous) => {
      const pasted = clipboardRef.current.map((item, index) => ({
        ...item,
        id: createId("item"),
        boardId: currentBoardId,
        x: clampPosition(item, { x: 40 + (item.x || 0), y: 40 + (item.y || 0) + index * 8 }).x,
        y: clampPosition(item, { x: 40 + (item.x || 0), y: 40 + (item.y || 0) + index * 8 }).y,
        createdAt: now(),
        updatedAt: now(),
        order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length + index,
      }));
      return {
        ...previous,
        items: [...previous.items, ...pasted],
      };
    });
  }

  function getBoardThumbnail(board) {
    if (board.thumbnailImage) return board.thumbnailImage;
    return state.items
      .filter((item) => item.boardId === board.id && item.type === "image" && item.imagePath)
      .sort(sortByOrder)[0]?.imagePath || "";
  }

  function openBoardContextMenu(event, board) {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      board,
    });
  }

  function openItemContextMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      item,
    });
  }

  function openAdd(type) {
    setIsAddMenuOpen(false);
    if (type === "board") {
      createSubBoard();
    } else {
      setDialog({ kind: "item", type });
    }
  }

  function handleExternalDragOver(event) {
    if (document.body.dataset.internalCardDrag === "true") return;
    if (!currentBoardId || !hasExternalDropData(event.dataTransfer)) return;
    event.preventDefault();
    setIsExternalDragOver(true);
  }

  function handleExternalDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsExternalDragOver(false);
    }
  }

  async function handleExternalDrop(event) {
    if (document.body.dataset.internalCardDrag === "true") return;
    if (!currentBoardId || !hasExternalDropData(event.dataTransfer)) return;
    event.preventDefault();
    setIsExternalDragOver(false);

    const boardRoot = document.querySelector("[data-board-root='true']");
    const zoom = Number(boardRoot?.dataset.zoom || settings.boardZoom || 1);
    const rect = boardRoot?.getBoundingClientRect();
    const dropPosition =
      rect && boardRoot
        ? {
            x: (event.clientX - rect.left) / zoom,
            y: (event.clientY - rect.top) / zoom,
          }
        : null;

    const droppedItem = await createDroppedVisualItem(event.dataTransfer);
    if (droppedItem) {
      const clampedPosition = dropPosition ? clampPosition(droppedItem, dropPosition) : null;
      addDroppedItem(droppedItem, clampedPosition);
    }
  }

  return (
    <div
      className={isExternalDragOver ? "app-shell external-drop-active" : "app-shell"}
      style={appShellStyle}
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
      onClick={() => setContextMenu(null)}
    >
      <header className="topbar" style={topbarStyle}>
        <button className="brand" type="button" onClick={() => setCurrentBoardId(null)}>
          <span className="brand-mark">K</span>
          <span className="brand-title">Keep Board</span>
        </button>
        <input
          className="search"
          placeholder={currentBoard ? "繧ｵ繝繝阪う繝ｫ繧呈､懃ｴ｢" : "繝懊・繝峨ｒ讀懃ｴ｢"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="top-actions">
          <button
            className="toolbar-button compact"
            type="button"
            onClick={undoState}
            title="元に戻す"
            aria-label="元に戻す"
            disabled={!canUndo}
          >
            <span>↶</span>
          </button>
          <button
            className="toolbar-button compact"
            type="button"
            onClick={redoState}
            title="やり直す"
            aria-label="やり直す"
            disabled={!canRedo}
          >
            <span>↷</span>
          </button>
          {currentBoard && (
            <button
              className="toolbar-button"
              type="button"
              onClick={() => setCurrentBoardId(currentBoard.parentBoardId || null)}
              title="一つ上へ戻る"
              aria-label="一つ上へ戻る"
            >
              <span>←</span>
              <b>戻る</b>
            </button>
          )}
          <button
            className="toolbar-button compact"
            type="button"
            onClick={() => setDialog({ kind: "settings" })}
            title="設定"
            aria-label="設定"
          >
            <span>⚙</span>
          </button>
          <button
            className="toolbar-button accent"
            type="button"
            onClick={() => setDialog({ kind: "board" })}
            title="新規ボード"
            aria-label="新規ボード"
          >
            <span>＋</span>
            <b>ボード</b>
          </button>
        </div>
      </header>

      <main className="main">
        {currentBoard ? (
          <>
            <section className="board-header">
              <div>
                <Breadcrumbs
                  path={getBoardPath(currentBoard)}
                  onHome={() => setCurrentBoardId(null)}
                  onMove={setCurrentBoardId}
                />
                {editingTitle ? (
                  <form
                    className="inline-title-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (titleDraft.trim()) updateBoard(currentBoard.id, titleDraft.trim());
                      setEditingTitle(false);
                    }}
                  >
                    <input
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onBlur={() => {
                        if (titleDraft.trim()) updateBoard(currentBoard.id, titleDraft.trim());
                        setEditingTitle(false);
                      }}
                      autoFocus
                    />
                  </form>
                ) : (
                  <h1
                    className="heading editable-heading"
                    onDoubleClick={() => {
                      setTitleDraft(currentBoard.title);
                      setEditingTitle(true);
                    }}
                  >
                    {currentBoard.title}
                  </h1>
                )}
              </div>
              <div className="menu">
                <button
                  className="toolbar-button accent board-add"
                  type="button"
                  onClick={() => setIsAddMenuOpen((value) => !value)}
                  title="カードを追加"
                  aria-label="カードを追加"
                >
                  <span>＋</span>
                  <b>カード</b>
                </button>
                <div className="menu-panel" hidden={!isAddMenuOpen}>
                  <button type="button" onClick={() => openAdd("note")}>
                    メモ
                  </button>
                  <button type="button" onClick={() => openAdd("image")}>
                    画像
                  </button>
                  <button type="button" onClick={() => openAdd("video")}>
                    動画
                  </button>
                  <button type="button" onClick={() => openAdd("link")}>
                    リンク
                  </button>
                  <button type="button" onClick={() => openAdd("board")}>
                    サブボード
                  </button>
                </div>
              </div>
            </section>
            <LabelSidebar
              labels={boardLabels}
              selectedLabels={selectedLabels}
              onToggle={(label) =>
                setSelectedLabels((labels) =>
                  labels.includes(label) ? labels.filter((item) => item !== label) : [...labels, label],
                )
              }
              onClear={() => setSelectedLabels([])}
            />
            <ToolSidebar
              onPick={(tool) => {
                if (tool === "image" || tool === "video" || tool === "link" || tool === "note") {
                  setDialog({ kind: "item", type: tool });
                  return;
                }
                if (tool === "board") {
                  createSubBoard();
                  return;
                }
                if (tool === "draw") {
                  setDialog({ kind: "draw" });
                  return;
                }
                createQuickItem(tool, { x: 40, y: 40 });
              }}
            />
            <BoardCanvas
              items={visibleBoardItems}
              boards={state.boards}
              zoom={settings.boardZoom}
              selectedIds={selectedItemIds}
              onSelectedIdsChange={setSelectedItemIds}
              onZoomChange={(boardZoom) => setSettings((current) => ({ ...current, boardZoom }))}
              getBoardThumbnail={getBoardThumbnail}
              activeCaptionId={activeCaptionId}
              onOpenBoard={setCurrentBoardId}
              onEditBoard={(board) => setDialog({ kind: "board", board })}
              onBoardContextMenu={openBoardContextMenu}
              onEdit={(target) => setDialog({ kind: "item", type: target.type, item: target })}
              onDelete={deleteItem}
              onResize={resizeMediaItem}
              onToggleCaption={setActiveCaptionId}
              onOpenLightbox={setLightboxId}
              onItemContextMenu={openItemContextMenu}
              onMove={moveItemsOnBoard}
              onMoveToBoard={moveItemToBoard}
              onQuickAdd={(tool, position) => {
                if (tool === "board") {
                  createSubBoard();
                  return;
                }
                if (tool === "draw") {
                  setDialog({ kind: "draw", position });
                  return;
                }
                createQuickItem(tool, position);
              }}
            />
            {!visibleBoardItems.length && (
              <p className="empty">{query ? "一致するカードがありません。" : "追加ボタンからカードを置けます。"}</p>
            )}
            <div className="drop-hint" aria-hidden={!isExternalDragOver}>
              ここにドロップしてカードを追加
            </div>
          </>
        ) : (
          <>
            <section className="board-header">
              <div>
                <h1 className="heading">繝帙・繝</h1>
              </div>
            </section>
            <SortableGrid ids={visibleRootBoards.map((board) => board.id)} sensors={sensors} onDragEnd={handleHomeDragEnd}>
              {visibleRootBoards.map((board) => (
                <SortableCard key={board.id} id={board.id} span={3} rows={4}>
                  <BoardCard
                    board={board}
                    thumbnail={getBoardThumbnail(board)}
                    count={state.items.filter((item) => item.boardId === board.id).length}
                    onOpen={() => setCurrentBoardId(board.id)}
                    onEdit={() => setDialog({ kind: "board", board })}
                    onDelete={() => deleteBoard(board.id)}
                    onContextMenu={(event) => openBoardContextMenu(event, board)}
                  />
                </SortableCard>
              ))}
            </SortableGrid>
            {!rootBoards.length && <p className="empty">右上の新規ボードから始めましょう。</p>}
            {rootBoards.length > 0 && !visibleRootBoards.length && <p className="empty">一致するボードがありません。</p>}
          </>
        )}
      </main>

      {dialog?.kind === "board" && (
        <BoardDialog
          board={dialog.board}
          onClose={() => setDialog(null)}
          onSave={(values) => {
            if (dialog.board) {
              updateBoard(dialog.board.id, values);
            } else {
              createBoard(values, null);
            }
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "item" && (
        <ItemDialog
          item={dialog.item}
          type={dialog.type}
          onClose={() => setDialog(null)}
          onSave={async (values) => {
            await saveItem(dialog.type, values, dialog.item);
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "settings" && (
        <SettingsDialog
          settings={settings}
          theme={theme}
          onClose={() => setDialog(null)}
          onSave={(nextSettings, nextTheme) => {
            setSettings(nextSettings);
            setTheme(nextTheme);
            setDialog(null);
          }}
        />
      )}

      {dialog?.kind === "draw" && (
        <DrawDialog
          onClose={() => setDialog(null)}
          onSave={(payload) => {
            const createdAt = now();
            updateState((previous) => ({
              ...previous,
              items: [
                ...previous.items,
                {
                  id: createId("item"),
                  boardId: currentBoardId,
                  linkedBoardId: "",
                  type: "draw",
                  title: "Sticker",
                  content: "",
                  imagePath: payload.imagePath,
                  label: "",
                  sticker: true,
                  widthUnits: 4,
                  heightUnits: 4,
                  x: dialog.position?.x,
                  y: dialog.position?.y,
                  order: previous.items.filter((candidate) => candidate.boardId === currentBoardId).length,
                  createdAt,
                  updatedAt: createdAt,
                },
              ],
            }));
            setDialog(null);
          }}
        />
      )}

      {contextMenu?.board && (
        <BoardContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onEdit={() => {
            setDialog({ kind: "board", board: contextMenu.board });
            setContextMenu(null);
          }}
          onDelete={() => {
            deleteBoard(contextMenu.board.id);
            setContextMenu(null);
          }}
        />
      )}

      {contextMenu?.item && (
        <ItemContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          item={contextMenu.item}
          onEdit={() => {
            setDialog({ kind: "item", type: contextMenu.item.type, item: contextMenu.item });
            setContextMenu(null);
          }}
          onDuplicate={() => {
            setContextMenu(null);
            duplicateSelectedItems([contextMenu.item.id]);
          }}
          onDownload={() => {
            const link = document.createElement("a");
            link.href = contextMenu.item.imagePath || contextMenu.item.url || "#";
            link.download = `${contextMenu.item.title || "card"}.${contextMenu.item.type === "video" ? "mp4" : "png"}`;
            link.click();
            setContextMenu(null);
          }}
          onOpenAsset={() => {
            window.open(contextMenu.item.imagePath || contextMenu.item.url, "_blank", "noopener,noreferrer");
            setContextMenu(null);
          }}
          onDelete={() => {
            deleteItem(contextMenu.item);
            setContextMenu(null);
          }}
        />
      )}

      {lightboxItem && (
        <Lightbox
          item={lightboxItem}
          hasPrevious={lightboxIndex > 0}
          hasNext={lightboxIndex < visibleImages.length - 1}
          onClose={() => setLightboxId(null)}
          onPrevious={() => setLightboxId(visibleImages[lightboxIndex - 1]?.id || lightboxItem.id)}
          onNext={() => setLightboxId(visibleImages[lightboxIndex + 1]?.id || lightboxItem.id)}
        />
      )}
    </div>
  );
}

function matchesSearch(record, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [record.title, record.content, record.url, record.label]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(normalized));
}

function matchesLabel(item, selectedLabels) {
  return selectedLabels.length === 0 || selectedLabels.includes(item.label);
}

function getItemSize(item) {
  const widthUnits = item.widthUnits || (item.type === "image" || item.type === "video" ? 4 : 3);
  const heightUnits = getItemRows(item);
  return {
    width: widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP,
    height: heightUnits * BOARD_ROW + (heightUnits - 1) * BOARD_GAP,
  };
}

function withDefaultPosition(item, index) {
  const width = getItemSize(item).width;
  const columns = Math.max(1, Math.floor(BOARD_CANVAS_WIDTH / Math.max(width + BOARD_GAP, 1)));
  return {
    ...item,
    x: Number.isFinite(item.x) ? item.x : (index % columns) * (width + BOARD_GAP),
    y: Number.isFinite(item.y) ? item.y : Math.floor(index / columns) * 260,
  };
}

function itemRect(item) {
  const size = getItemSize(item);
  return {
    x: item.x || 0,
    y: item.y || 0,
    width: size.width,
    height: size.height,
  };
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampPosition(item, position) {
  const size = getItemSize(item);
  return {
    x: clamp(Math.round(position.x / 10) * 10, 0, Math.max(0, BOARD_CANVAS_WIDTH - size.width)),
    y: Math.max(0, Math.round(position.y / 10) * 10),
  };
}

function getOverlapArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function getOverlapRatio(a, b) {
  const overlapArea = getOverlapArea(a, b);
  if (!overlapArea) return 0;
  return overlapArea / Math.min(a.width * a.height, b.width * b.height);
}

function distanceBetweenPositions(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function findNearestOpenPosition(item, items, preferredPosition, excludeIds = new Set()) {
  if (item.sticker) {
    return clampPosition(item, preferredPosition);
  }
  const size = getItemSize(item);
  const maxY =
    items.reduce((value, candidate) => Math.max(value, (candidate.y || 0) + itemRect(candidate).height), 0) + 2400;
  const start = clampPosition(item, preferredPosition);
  let best = null;

  for (let radius = 0; radius <= maxY + BOARD_CANVAS_WIDTH; radius += BOARD_DROP_STEP) {
    for (let y = Math.max(0, start.y - radius); y <= Math.min(maxY, start.y + radius); y += BOARD_DROP_STEP) {
      const horizontalReach = Math.max(0, radius - Math.abs(y - start.y));
      const candidates = horizontalReach
        ? [start.x - horizontalReach, start.x + horizontalReach]
        : [start.x];

      for (const rawX of candidates) {
        const candidate = clampPosition(item, { x: rawX, y });
        const rect = { x: candidate.x, y: candidate.y, width: size.width, height: size.height };
        const hasCollision = items.some((other) => {
          if (other.id === item.id || excludeIds.has(other.id) || other.sticker) return false;
          return overlaps(rect, itemRect(other));
        });

        if (!hasCollision) {
          const score = distanceBetweenPositions(candidate, start);
          if (!best || score < best.score) {
            best = { ...candidate, score };
          }
        }
      }
    }

    if (best) break;
  }

  return best ? { x: best.x, y: best.y } : start;
}

function resolveBoardPlacement(items, movedIds) {
  const movedSet = new Set(movedIds);
  const resolved = items.map((item) => ({ ...item }));
  const byId = new Map(resolved.map((item) => [item.id, item]));

  for (const item of resolved) {
    if (movedSet.has(item.id)) {
      Object.assign(item, clampPosition(item, item));
    }
  }

  if (movedIds.length === 1) {
    const moved = byId.get(movedIds[0]);
    if (moved?.sticker) {
      return resolved.map((item) => {
        const clone = { ...item };
        delete clone.originX;
        delete clone.originY;
        return clone;
      });
    }
    const stationary = resolved.filter((item) => item.id !== moved.id);
    const collisions = stationary
      .map((candidate) => ({
        candidate,
        ratio: getOverlapRatio(itemRect(moved), itemRect(candidate)),
      }))
      .filter((entry) => entry.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio);

    if (collisions[0]) {
      if (collisions[0].ratio < SWAP_OVERLAP_RATIO) {
        Object.assign(
          moved,
          findNearestOpenPosition(moved, stationary, { x: moved.x || 0, y: moved.y || 0 }),
        );
      } else {
        const target = collisions[0].candidate;
        const movedOrigin = { x: moved.originX ?? moved.x ?? 0, y: moved.originY ?? moved.y ?? 0 };
        const targetOrigin = { x: target.x || 0, y: target.y || 0 };

        Object.assign(moved, findNearestOpenPosition(moved, stationary, targetOrigin, new Set([target.id])));
        Object.assign(
          target,
          findNearestOpenPosition(
            target,
            resolved.filter((item) => item.id !== target.id),
            movedOrigin,
            new Set([moved.id]),
          ),
        );
      }
    }
  }

  const fixed = [];
  const moving = [];
  for (const item of resolved) {
    if (movedSet.has(item.id)) {
      moving.push(item);
    } else {
      fixed.push(item);
    }
  }

  for (const item of moving.sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))) {
    Object.assign(
      item,
      findNearestOpenPosition(item, [...fixed, ...moving.filter((candidate) => candidate.id !== item.id)], {
        x: item.x || 0,
        y: item.y || 0,
      }),
    );
    fixed.push(item);
  }

  return resolved.map((item) => {
    const clone = { ...item };
    delete clone.originX;
    delete clone.originY;
    return clone;
  });
}

function rectContainsPoint(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function getDragCollisionPreview(positionedById, dragState, offset) {
  if (!dragState || dragState.ids.length !== 1) return null;
  const moved = positionedById.get(dragState.ids[0]);
  if (!moved) return null;
  const movedRect = itemRect({
    ...moved,
    x: clampPosition(moved, { x: dragState.origins[moved.id].x + offset.x, y: dragState.origins[moved.id].y + offset.y }).x,
    y: clampPosition(moved, { x: dragState.origins[moved.id].x + offset.x, y: dragState.origins[moved.id].y + offset.y }).y,
  });
  const collisions = [...positionedById.values()]
    .filter((candidate) => candidate.id !== moved.id && !candidate.sticker)
    .map((candidate) => ({
      id: candidate.id,
      ratio: getOverlapRatio(movedRect, itemRect(candidate)),
    }))
    .filter((entry) => entry.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio);
  if (!collisions.length) return null;
  return {
    targetId: collisions[0].id,
    mode: collisions[0].ratio >= SWAP_OVERLAP_RATIO ? "swap" : "push",
  };
}

function normalizeSelectionRect(start, current) {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

function intersectsSelection(item, selection) {
  return overlaps(itemRect(item), selection);
}

function buildSurfaceStyle(mode, color, image, fallback) {
  if (mode === "image" && image) {
    return {
      backgroundColor: fallback,
      backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.18)), url(${image})`,
      backgroundPosition: "center",
      backgroundSize: "cover",
      backgroundRepeat: "no-repeat",
    };
  }

  if (mode === "solid" && color) {
    return {
      background: color,
    };
  }

  return {};
}

function getItemRows(item) {
  if (item.heightUnits) return item.heightUnits;
  if (item.aspectRatio && (item.type === "image" || item.type === "video")) {
    const widthUnits = item.widthUnits || 4;
    const width = widthUnits * BOARD_UNIT + (widthUnits - 1) * BOARD_GAP;
    return clamp(
      Math.round((width / Math.max(item.aspectRatio, 0.2) + BOARD_GAP) / (BOARD_ROW + BOARD_GAP)),
      MIN_CARD_ROWS,
      MAX_CARD_ROWS,
    );
  }
  if (item.type === "image" || item.type === "video") return 4;
  if (item.type === "board") return 3;
  return Math.min(6, Math.max(2, Math.ceil(((item.title || "").length + (item.content || "").length) / 80) + 2));
}

function hasExternalDropData(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return (
    types.includes("Files") ||
    types.includes("text/uri-list") ||
    types.includes("text/html") ||
    types.includes("text/plain")
  );
}

async function createItemFromDrop(dataTransfer) {
  const file = Array.from(dataTransfer.files || []).find((candidate) =>
    candidate.type.startsWith("image/") || candidate.type.startsWith("video/"),
  );

  if (file) {
    const type = file.type.startsWith("video/") ? "video" : "image";
    return {
      type,
      title: file.name.replace(/\.[^.]+$/, "") || (type === "video" ? "動画" : "画像"),
      content: "",
      imagePath: await readImageFile(file),
      url: "",
      widthUnits: 4,
      heightUnits: 4,
    };
  }

  const html = dataTransfer.getData("text/html");
  const uri = cleanDroppedUrl(dataTransfer.getData("text/uri-list"));
  const text = dataTransfer.getData("text/plain").trim();
  const imageUrl = getImageUrlFromHtml(html) || (isImageUrl(uri) ? uri : "");
  const videoUrl = isVideoUrl(uri) ? uri : "";
  const url = uri || extractFirstUrl(text) || extractFirstUrl(html);

  if (videoUrl) {
    return {
      type: "video",
      title: titleFromUrl(videoUrl) || "繝峨Ο繝・・蜍慕判",
      content: "",
      imagePath: videoUrl,
      url: videoUrl,
      widthUnits: 4,
      heightUnits: 4,
    };
  }

  if (imageUrl) {
    return {
      type: "image",
      title: titleFromUrl(imageUrl) || "画像",
      content: url && url !== imageUrl ? url : "",
      imagePath: imageUrl,
      url: imageUrl,
      widthUnits: 4,
      heightUnits: 4,
    };
  }

  if (url) {
    return {
      type: "link",
      title: titleFromUrl(url) || "繝ｪ繝ｳ繧ｯ",
      content: text && text !== url ? text : "",
      imagePath: "",
      url,
      widthUnits: 2,
      heightUnits: 2,
    };
  }

  if (text) {
    return {
      type: "note",
      title: text.split(/\r?\n/)[0].slice(0, 60) || "繝峨Ο繝・・繝｡繝｢",
      content: text,
      imagePath: "",
      url: "",
      widthUnits: 2,
      heightUnits: 2,
    };
  }

  return null;
}

function cleanDroppedUrl(value) {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) || ""
  );
}

function extractFirstUrl(value) {
  return value.match(/https?:\/\/[^\s"'<>]+/)?.[0] || "";
}

function getImageUrlFromHtml(html) {
  if (!html) return "";
  const parsedDocument = new DOMParser().parseFromString(html, "text/html");
  return parsedDocument.querySelector("img")?.src || "";
}

function isImageUrl(value) {
  return /\.(apng|avif|gif|jpe?g|png|svg|webp)(\?.*)?$/i.test(value);
}

function isVideoUrl(value) {
  return /\.(mp4|m4v|mov|webm|ogv|ogg|avi|mkv)(\?.*)?$/i.test(value);
}

function titleFromUrl(value) {
  try {
    const url = new URL(value);
    const lastPath = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return lastPath.replace(/\.[^.]+$/, "") || url.hostname;
  } catch {
    return "";
  }
}

async function createDroppedVisualItem(dataTransfer) {
  const file = Array.from(dataTransfer.files || []).find((candidate) =>
    candidate.type.startsWith("image/") || candidate.type.startsWith("video/"),
  );

  if (file) {
    const type = file.type.startsWith("video/") ? "video" : "image";
    const imagePath = await readImageFile(file);
    const dimensions = await probeMediaDimensions(imagePath, type);
    return {
      type,
      title: file.name.replace(/\.[^.]+$/, "") || file.name,
      content: "",
      imagePath,
      url: "",
      ...getAspectBasedCardSize(dimensions.width, dimensions.height, type),
    };
  }

  const html = dataTransfer.getData("text/html");
  const uri = cleanDroppedUrl(dataTransfer.getData("text/uri-list"));
  const text = dataTransfer.getData("text/plain").trim();
  const imageUrl = getImageUrlFromHtml(html) || (isImageUrl(uri) ? uri : "");
  const videoUrl = isVideoUrl(uri) ? uri : "";
  const url = uri || extractFirstUrl(text) || extractFirstUrl(html);

  if (videoUrl) {
    const dimensions = await probeMediaDimensions(videoUrl, "video");
    return {
      type: "video",
      title: titleFromUrl(videoUrl) || "Video",
      content: "",
      imagePath: videoUrl,
      url: videoUrl,
      ...getAspectBasedCardSize(dimensions.width, dimensions.height, "video"),
    };
  }

  if (imageUrl) {
    const dimensions = await probeMediaDimensions(imageUrl, "image");
    return {
      type: "image",
      title: titleFromUrl(imageUrl) || "Image",
      content: url && url !== imageUrl ? url : "",
      imagePath: imageUrl,
      url: imageUrl,
      ...getAspectBasedCardSize(dimensions.width, dimensions.height, "image"),
    };
  }

  return createItemFromDrop(dataTransfer);
}

function SortableGrid({ children, ids, onDragEnd, sensors }) {
  if (!ids.length) return null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <section className="grid">{children}</section>
      </SortableContext>
    </DndContext>
  );
}

function SortableCard({ children, id, span = 2, rows = 2 }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    "--span": span,
    "--rows": rows,
  };

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? "sortable dragging" : "sortable"}
      style={style}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function BoardCanvas({
  items,
  boards,
  zoom,
  selectedIds,
  onSelectedIdsChange,
  onZoomChange,
  getBoardThumbnail,
  activeCaptionId,
  onOpenBoard,
  onEditBoard,
  onBoardContextMenu,
  onEdit,
  onDelete,
  onResize,
  onToggleCaption,
  onOpenLightbox,
  onItemContextMenu,
  onMove,
  onMoveToBoard,
  onQuickAdd,
}) {
  const viewportRef = useRef(null);
  const boardRef = useRef(null);
  const dragFrameRef = useRef(0);
  const [selectionRect, setSelectionRect] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [panState, setPanState] = useState(null);
  const positionedItems = useMemo(() => items.map((item, index) => withDefaultPosition(item, index)), [items]);
  const positionedById = useMemo(
    () => new Map(positionedItems.map((item) => [item.id, item])),
    [positionedItems],
  );
  const canvasHeight =
    positionedItems.reduce((height, item) => Math.max(height, item.y + itemRect(item).height), 360) + 180;

  useEffect(() => {
    function handleGlobalPointerMove(event) {
      if (panState) {
        event.preventDefault();
        const viewport = viewportRef.current;
        if (!viewport) return;
        viewport.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
        window.scrollTo({ top: Math.max(0, panState.scrollTop - (event.clientY - panState.startY)) });
        return;
      }

      if (selectionRect) {
        const current = toBoardPoint(event.clientX, event.clientY);
        const nextRect = normalizeSelectionRect(selectionRect.anchor, current);
        setSelectionRect({ ...selectionRect, current, rect: nextRect });
        onSelectedIdsChange(
          positionedItems.filter((item) => intersectsSelection(item, nextRect)).map((item) => item.id),
        );
        return;
      }

      if (!dragState) return;
      event.preventDefault();
      const point = toBoardPoint(event.clientX, event.clientY);
      const deltaX = point.x - dragState.startPoint.x;
      const deltaY = point.y - dragState.startPoint.y;
      const nextOffset = { x: deltaX, y: deltaY };
      const collisionPreview = getDragCollisionPreview(positionedById, dragState, nextOffset);
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = requestAnimationFrame(() => {
        setDragState((currentState) => ({
          ...currentState,
          offset: nextOffset,
          collisionPreview,
        }));
      });
    }

    function handleGlobalPointerUp(event) {
      if (panState) {
        setPanState(null);
        return;
      }

      if (selectionRect) {
        setSelectionRect(null);
        return;
      }

      if (!dragState) return;
      const dropBoard = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest?.("[data-board-drop-id]"))
        .find(Boolean);
      const targetBoardId = dropBoard?.dataset.boardDropId;

      const movedIds = dragState.ids;
      const preview = Object.fromEntries(
        movedIds.map((id) => {
          const origin = dragState.origins[id];
          const item = positionedById.get(id);
          const position = clampPosition(item, {
            x: origin.x + (dragState.offset?.x || 0),
            y: origin.y + (dragState.offset?.y || 0),
          });
          return [id, position];
        }),
      );
      setDragState(null);
      cancelAnimationFrame(dragFrameRef.current);
      window.setTimeout(() => {
        delete document.body.dataset.internalCardDrag;
      }, 0);

      if (targetBoardId && movedIds.length === 1) {
        const moved = positionedById.get(movedIds[0]);
        if (targetBoardId && targetBoardId !== moved.linkedBoardId) {
          onMoveToBoard(moved, targetBoardId);
          return;
        }
      }

      onMove(movedIds, preview);
    }

    window.addEventListener("pointermove", handleGlobalPointerMove, { passive: false });
    window.addEventListener("pointerup", handleGlobalPointerUp);
    window.addEventListener("pointercancel", handleGlobalPointerUp);
    return () => {
      cancelAnimationFrame(dragFrameRef.current);
      window.removeEventListener("pointermove", handleGlobalPointerMove);
      window.removeEventListener("pointerup", handleGlobalPointerUp);
      window.removeEventListener("pointercancel", handleGlobalPointerUp);
    };
  }, [dragState, onMove, onMoveToBoard, onSelectedIdsChange, panState, positionedById, positionedItems, selectionRect]);

  function toBoardPoint(clientX, clientY) {
    const boardRect = boardRef.current?.getBoundingClientRect();
    if (!boardRect) return { x: 0, y: 0 };
    return {
      x: (clientX - boardRect.left) / zoom,
      y: (clientY - boardRect.top) / zoom,
    };
  }

  function handleViewportPointerDown(event) {
    if (event.button === 1) {
      event.preventDefault();
      const viewport = viewportRef.current;
      if (!viewport) return;
      setPanState({
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: window.scrollY,
      });
      return;
    }

    if (event.button !== 0) return;
    if (event.target.closest(".free-card, button, a, input, textarea, select, video")) return;

    const anchor = toBoardPoint(event.clientX, event.clientY);
    onSelectedIdsChange([]);
    setSelectionRect({
      anchor,
      current: anchor,
      rect: { x: anchor.x, y: anchor.y, width: 0, height: 0 },
    });
  }

  function handleWheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;

    const nextZoom = clamp(Number((zoom - event.deltaY * 0.0015).toFixed(2)), BOARD_ZOOM_MIN, BOARD_ZOOM_MAX);
    if (nextZoom === zoom) return;

    const boardRect = boardRef.current?.getBoundingClientRect();
    const pointerX = event.clientX - (boardRect?.left || 0);
    const pointerY = event.clientY - (boardRect?.top || 0);
    const contentX = (viewport.scrollLeft + pointerX) / zoom;
    const contentY = (viewport.scrollTop + pointerY) / zoom;

    onZoomChange(nextZoom);
    requestAnimationFrame(() => {
      viewport.scrollLeft = contentX * nextZoom - pointerX;
      window.scrollTo({ top: contentY * nextZoom - pointerY });
    });
  }

  function handleCardPointerDown(event, item) {
    if (event.button !== 0) return;
    if (event.target.closest("button, a, input, textarea, select, video, .resize-handle")) return;

    const point = toBoardPoint(event.clientX, event.clientY);
    const nextSelection =
      event.ctrlKey || event.metaKey
        ? selectedIds.includes(item.id)
          ? selectedIds.filter((id) => id !== item.id)
          : [...selectedIds, item.id]
        : selectedIds.includes(item.id)
          ? selectedIds
          : [item.id];

    const dragIds = nextSelection.length ? nextSelection : [item.id];
    onSelectedIdsChange(dragIds);
    document.body.dataset.internalCardDrag = "true";
    setDragState({
      ids: dragIds,
      startPoint: point,
      offset: { x: 0, y: 0 },
      origins: Object.fromEntries(
        dragIds.map((id) => {
          const positioned = positionedById.get(id);
          return [id, { x: positioned.x || 0, y: positioned.y || 0 }];
        }),
      ),
      collisionPreview: null,
    });
  }

  function handleBoardDragOver(event) {
    const tool = event.dataTransfer?.getData("application/x-keep-tool");
    if (!tool) return;
    event.preventDefault();
  }

  function handleBoardDrop(event) {
    const tool = event.dataTransfer?.getData("application/x-keep-tool");
    if (!tool) return;
    event.preventDefault();
    event.stopPropagation();
    const position = clampPosition(
      { widthUnits: 4, heightUnits: 4, type: tool, sticker: tool.startsWith("shape-") || tool === "draw" },
      toBoardPoint(event.clientX, event.clientY),
    );
    onQuickAdd(tool, position);
  }

  return (
    <div
      ref={viewportRef}
      className={panState ? "board-viewport panning" : "board-viewport"}
      onPointerDown={handleViewportPointerDown}
      onWheel={handleWheel}
      onDragOver={handleBoardDragOver}
      onDrop={handleBoardDrop}
    >
      <div
        className="board-scale-shell"
        style={{
          width: BOARD_CANVAS_WIDTH * zoom,
          minHeight: canvasHeight * zoom,
        }}
      >
        <section
          ref={boardRef}
          className="free-board"
          data-board-root="true"
          data-zoom={zoom}
          style={{
            width: BOARD_CANVAS_WIDTH,
            minHeight: canvasHeight,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
          }}
        >
          {positionedItems.map((item) => (
            <FreeCard
              key={item.id}
              item={positionedById.get(item.id) || item}
              boards={boards}
              selected={selectedIds.includes(item.id)}
              dragging={dragState?.ids.includes(item.id)}
              dragOffset={dragState?.ids.includes(item.id) ? dragState.offset : null}
              dropIndicator={
                dragState?.collisionPreview?.targetId === item.id ? dragState.collisionPreview.mode : null
              }
              getBoardThumbnail={getBoardThumbnail}
              activeCaptionId={activeCaptionId}
              onOpenBoard={onOpenBoard}
              onEditBoard={onEditBoard}
              onBoardContextMenu={onBoardContextMenu}
              onEdit={onEdit}
              onDelete={onDelete}
              onResize={onResize}
              onToggleCaption={onToggleCaption}
              onOpenLightbox={onOpenLightbox}
              onItemContextMenu={onItemContextMenu}
              onPointerDown={handleCardPointerDown}
            />
          ))}
          {selectionRect?.rect && (
            <div
              className="selection-box"
              style={{
                left: selectionRect.rect.x,
                top: selectionRect.rect.y,
                width: selectionRect.rect.width,
                height: selectionRect.rect.height,
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function FreeCard({
  item,
  boards,
  selected,
  dragging,
  dragOffset,
  dropIndicator,
  getBoardThumbnail,
  activeCaptionId,
  onOpenBoard,
  onEditBoard,
  onBoardContextMenu,
  onEdit,
  onDelete,
  onResize,
  onToggleCaption,
  onOpenLightbox,
  onItemContextMenu,
  onPointerDown,
}) {
  const board = boards.find((candidate) => candidate.id === item.linkedBoardId);
  const size = getItemSize(item);

  return (
    <div
      className={[
        "free-card",
        selected ? "selected-free" : "",
        dragging ? "dragging-free" : "",
        dropIndicator ? `drop-${dropIndicator}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: item.x || 0,
        top: item.y || 0,
        width: size.width,
        height: size.height,
        transform: dragOffset ? `translate3d(${dragOffset.x}px, ${dragOffset.y}px, 0)` : undefined,
      }}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => onPointerDown(event, item)}
      onDoubleClick={() => {
        if (item.type === "image" || item.type === "video") onOpenLightbox(item.id);
      }}
    >
      <ItemCard
        item={item}
        board={board}
        thumbnail={getBoardThumbnail(board || {})}
        isCaptionVisible={activeCaptionId === item.id}
        onOpenBoard={onOpenBoard}
        onEditBoard={onEditBoard}
        onBoardContextMenu={onBoardContextMenu}
        onEdit={onEdit}
        onDelete={onDelete}
        onResize={onResize}
        onToggleCaption={onToggleCaption}
        onOpenLightbox={onOpenLightbox}
        onItemContextMenu={onItemContextMenu}
      />
    </div>
  );
}

function LabelSidebar({ labels, selectedLabels, onToggle, onClear }) {
  return (
    <aside className="label-sidebar">
      <div className="label-tab">Labels</div>
      <div className="label-panel">
        <div className="label-panel-title">ラベル</div>
        {!labels.length && <p>このボードにはまだラベルがありません。</p>}
        {labels.map((label) => (
          <label className="label-check" key={label}>
            <input
              type="checkbox"
              checked={selectedLabels.includes(label)}
              onChange={() => onToggle(label)}
            />
            <span>{label}</span>
          </label>
        ))}
        {!!selectedLabels.length && (
          <button className="ghost" type="button" onClick={onClear}>
            すべて表示
          </button>
        )}
      </div>
    </aside>
  );
}

function ToolSidebar({ onPick }) {
  const tools = [
    { id: "note", label: "Note", icon: "📝" },
    { id: "link", label: "Link", icon: "🔗" },
    { id: "todo", label: "To-do", icon: "☑" },
    { id: "comment", label: "Comment", icon: "💬" },
    { id: "column", label: "Column", icon: "▤" },
    { id: "table", label: "Table", icon: "▦" },
    { id: "board", label: "Board", icon: "◫" },
    { id: "shape-line", label: "Line", icon: "／" },
    { id: "shape-rect", label: "Rect", icon: "▭" },
    { id: "shape-circle", label: "Circle", icon: "◯" },
    { id: "draw", label: "Draw", icon: "✎" },
  ];

  return (
    <aside className="tool-sidebar">
      {tools.map((tool) => (
        <button
          key={tool.id}
          className="tool-button"
          type="button"
          draggable
          onClick={() => onPick(tool.id)}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-keep-tool", tool.id);
          }}
        >
          <span>{tool.icon}</span>
          <small>{tool.label}</small>
        </button>
      ))}
    </aside>
  );
}

function Breadcrumbs({ path, onHome, onMove }) {
  return (
    <nav className="crumbs" aria-label="繝代Φ縺上★">
      <button className="crumb" type="button" onClick={onHome}>
        繝帙・繝
      </button>
      {path.map((board, index) => (
        <span className="crumb-group" key={board.id}>
          <span> / </span>
          <button
            className="crumb"
            type="button"
            aria-current={index === path.length - 1 ? "page" : undefined}
            onClick={() => index !== path.length - 1 && onMove(board.id)}
          >
            {board.title}
          </button>
        </span>
      ))}
    </nav>
  );
}

function BoardCard({ board, thumbnail, count, onOpen, onContextMenu }) {
  return (
    <article
      className="card board-card"
      data-board-drop-id={board.id}
      onClick={onOpen}
      onContextMenu={onContextMenu}
    >
      {thumbnail && (
        <div className="board-thumb">
          <img src={thumbnail} alt="" />
        </div>
      )}
      <div className="card-body">
        <h2
          className="card-title board-title"
          style={{
            color: board.fontColor || undefined,
            fontWeight: board.fontWeight || undefined,
          }}
        >
          {board.title}
        </h2>
        <p className="card-content">{count} 件のカード</p>
      </div>
    </article>
  );
}

function ItemCard({
  item,
  board,
  thumbnail,
  isCaptionVisible,
  onOpenBoard,
  onEditBoard,
  onBoardContextMenu,
  onEdit,
  onDelete,
  onResize,
  onToggleCaption,
  onOpenLightbox,
  onItemContextMenu,
}) {
  if (item.type === "board") {
    return (
      <article
        className="card board-card"
        data-board-drop-id={board?.id || ""}
        onClick={() => board && onOpenBoard(board.id)}
        onContextMenu={(event) => board && onBoardContextMenu(event, board)}
      >
        {thumbnail && (
          <div className="board-thumb">
            <img src={thumbnail} alt="" />
          </div>
        )}
        <div className="card-body">
          <h2
            className="card-title board-title"
            style={{
              color: board?.fontColor || undefined,
              fontWeight: board?.fontWeight || undefined,
            }}
          >
            {board?.title || item.title}
          </h2>
          <p className="card-content">サブボード</p>
        </div>
      </article>
    );
  }

  if (item.type === "image" && item.imagePath) {
    return (
      <article
        className={isCaptionVisible ? "card media-card caption-visible" : "card media-card"}
        onClick={() => onToggleCaption(isCaptionVisible ? null : item.id)}
        onDoubleClick={() => onOpenLightbox(item.id)}
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="media-frame">
          <img src={item.imagePath} alt={item.title || "画像カード"} draggable="false" />
          <div className="media-caption">
            {item.label && <div className="chip">{item.label}</div>}
            <div className="caption-title">{item.title || "Untitled"}</div>
            {item.content && <div className="caption-content">{item.content}</div>}
          </div>
        </div>
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  if (item.type === "video" && item.imagePath) {
    return (
      <article
        className={isCaptionVisible ? "card media-card caption-visible" : "card media-card"}
        onClick={() => onToggleCaption(isCaptionVisible ? null : item.id)}
        onDoubleClick={() => onOpenLightbox(item.id)}
        onContextMenu={(event) => onItemContextMenu(event, item)}
        onDragStart={(event) => event.preventDefault()}
      >
        <div className="media-frame">
          <video src={item.imagePath} controls muted preload="metadata" draggable="false" />
          <div className="media-caption">
            {item.label && <div className="chip">{item.label}</div>}
            <div className="caption-title">{item.title || "Untitled"}</div>
            {item.content && <div className="caption-content">{item.content}</div>}
          </div>
        </div>
        <ResizeHandle item={item} onResize={onResize} />
      </article>
    );
  }

  return (
    <article className="card" onContextMenu={(event) => onItemContextMenu(event, item)}>
      <div className="card-body">
        <div className="card-kicker">{itemLabels[item.type]}</div>
        <h2 className="card-title">{item.title || itemLabels[item.type]}</h2>
        {item.label && <span className="chip inline-chip">{item.label}</span>}
        {item.content && <p className="card-content">{item.content}</p>}
        {item.type === "link" && item.url && (
          <a className="card-link" href={item.url} target="_blank" rel="noreferrer">
            {item.url}
          </a>
        )}
      </div>
    </article>
  );
}

function ResizeHandle({ item, onResize }) {
  function handlePointerDown(event) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startSpan = item.widthUnits || 3;
    const startRows = item.heightUnits || 4;

    function handlePointerMove(moveEvent) {
      const delta = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const stepsX = Math.round(delta / 38);
      const stepsY = Math.round(deltaY / 34);
      onResize(item.id, startSpan + stepsX, startRows + stepsY);
    }

    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }

  return (
    <button
      className="resize-handle"
      type="button"
      onPointerDown={handlePointerDown}
      title="逕ｻ蜒上し繧､繧ｺ繧定ｪｿ遽"
      aria-label="逕ｻ蜒上し繧､繧ｺ繧定ｪｿ遽"
    />
  );
}

function CardActions({ onEdit, onDelete }) {
  return (
    <div className="card-actions" onClick={(event) => event.stopPropagation()}>
      <button className="ghost" type="button" onClick={onEdit}>
        邱ｨ髮・      </button>
      <button className="ghost danger" type="button" onClick={onDelete}>
        蜑企勁
      </button>
    </div>
  );
}

function BoardDialog({ board, onClose, onSave }) {
  const [title, setTitle] = useState(board?.title || "");
  const [fontColor, setFontColor] = useState(board?.fontColor || "#232323");
  const [fontWeight, setFontWeight] = useState(board?.fontWeight || "700");
  const [thumbnailImage, setThumbnailImage] = useState(board?.thumbnailImage || "");

  async function handleThumbnailChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setThumbnailImage(await readImageFile(file));
  }

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onSave({
            title: title.trim(),
            fontColor,
            fontWeight,
            thumbnailImage,
          });
        }}
      >
        <h2>{board ? "ボードを編集" : "ボードを作成"}</h2>
        <label className="field">
          <span>タイトル</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>タイトル色</span>
          <input value={fontColor} onChange={(event) => setFontColor(event.target.value)} type="color" />
        </label>
        <label className="field">
          <span>タイトルの太さ</span>
          <select value={fontWeight} onChange={(event) => setFontWeight(event.target.value)}>
            <option value="500">標準</option>
            <option value="700">太字</option>
            <option value="900">極太</option>
          </select>
        </label>
        <label className="field">
          <span>サムネイル画像</span>
          <input type="file" accept="image/*" onChange={handleThumbnailChange} />
        </label>
        {thumbnailImage && (
          <div className="thumb-preview">
            <img src={thumbnailImage} alt="" />
            <button className="ghost" type="button" onClick={() => setThumbnailImage("")}>
              サムネイルを削除
            </button>
          </div>
        )}
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function ItemDialog({ item, type, onClose, onSave }) {
  const [title, setTitle] = useState(item?.title || "");
  const [content, setContent] = useState(item?.content || "");
  const [label, setLabel] = useState(item?.label || "");
  const [url, setUrl] = useState(item?.url || "");
  const [imageFile, setImageFile] = useState(null);

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          onSave({
            title: title.trim(),
            content: content.trim(),
            label: label.trim(),
            url: url.trim(),
            imageFile,
          });
        }}
      >
        <h2>{item ? `${itemLabels[type]}を編集` : `${itemLabels[type]}を作成`}</h2>
        <label className="field">
          <span>タイトル</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>{type === "image" ? "メモ" : "本文"}</span>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <label className="field">
          <span>ラベル</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例: お気に入り / 資料 / キャラ" />
        </label>
        {type === "link" && (
          <label className="field">
            <span>URL</span>
            <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" required />
          </label>
        )}
        {(type === "image" || type === "video") && (
          <label className="field">
            <span>{type === "video" ? "動画" : "画像"}</span>
            <input
              type="file"
              accept={type === "video" ? "video/*" : "image/*"}
              required={!item?.imagePath}
              onChange={(event) => setImageFile(event.target.files?.[0] || null)}
            />
          </label>
        )}
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function Dialog({ children, onClose }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  );
}

function DialogActions({ onClose }) {
  return (
    <div className="dialog-actions">
      <button className="secondary" type="button" onClick={onClose}>
        繧ｭ繝｣繝ｳ繧ｻ繝ｫ
      </button>
      <button className="primary" type="submit">
        菫晏ｭ・      </button>
    </div>
  );
}

function BoardContextMenu({ x, y, onEdit, onDelete }) {
  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      <button type="button" onClick={onEdit}>
        繝懊・繝峨ｒ邱ｨ髮・      </button>
      <button className="danger" type="button" onClick={onDelete}>
        繝懊・繝峨ｒ蜑企勁
      </button>
    </div>
  );
}

function ItemContextMenu({ x, y, item, onEdit, onDuplicate, onDownload, onOpenAsset, onDelete }) {
  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      {(item.type === "image" || item.type === "video") && (
        <>
          <button type="button" onClick={onOpenAsset}>
            画像を開く
          </button>
          <button type="button" onClick={onDownload}>
            画像をダウンロード
          </button>
          <button type="button" onClick={onEdit}>
            画像を置換 / 編集
          </button>
        </>
      )}
      {item.type !== "image" && item.type !== "video" && (
        <button type="button" onClick={onEdit}>
          カードを編集
        </button>
      )}
      <button type="button" onClick={onDuplicate}>
        複製
      </button>
      <button className="danger" type="button" onClick={onDelete}>
        カードを削除
      </button>
    </div>
  );
}

function SettingsDialog({ settings, theme, onClose, onSave }) {
  const [draft, setDraft] = useState(settings);
  const [draftTheme, setDraftTheme] = useState(theme);

  async function handleImageSettingChange(key, event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setDraft((current) => ({ ...current, [key]: "" }));
    const image = await readImageFile(file);
    setDraft((current) => ({ ...current, [key]: image }));
  }

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft, draftTheme);
        }}
      >
        <h2>設定</h2>
        <label className="field">
          <span>表示モード</span>
          <select value={draftTheme} onChange={(event) => setDraftTheme(event.target.value)}>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
        </label>
        <label className="field">
          <span>初期フォントサイズ: {draft.fontSize}px</span>
          <input
            type="range"
            min="13"
            max="19"
            value={draft.fontSize}
            onChange={(event) => setDraft({ ...draft, fontSize: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          <span>ソート</span>
          <select value={draft.sortMode} onChange={(event) => setDraft({ ...draft, sortMode: event.target.value })}>
            <option value="manual">手動順</option>
            <option value="newest">追加順 新しい順</option>
            <option value="oldest">追加順 古い順</option>
            <option value="title">50音順</option>
          </select>
        </label>
        <label className="field">
          <span>ボード初期ズーム: {Math.round((draft.boardZoom || 1) * 100)}%</span>
          <input
            type="range"
            min={BOARD_ZOOM_MIN}
            max="1.5"
            step="0.01"
            value={draft.boardZoom || 1}
            onChange={(event) => setDraft({ ...draft, boardZoom: Number(event.target.value) })}
          />
        </label>
        <section className="settings-group">
          <h3>全体背景</h3>
          <label className="field">
            <span>モード</span>
            <select
              value={draft.appBackgroundMode}
              onChange={(event) => setDraft({ ...draft, appBackgroundMode: event.target.value })}
            >
              <option value="theme">テーマ標準</option>
              <option value="solid">単色</option>
              <option value="image">画像</option>
            </select>
          </label>
          {draft.appBackgroundMode === "solid" && (
            <label className="field">
              <span>背景色</span>
              <input
                type="color"
                value={draft.appBackgroundColor || (draftTheme === "dark" ? "#111315" : "#f6f7f8")}
                onChange={(event) => setDraft({ ...draft, appBackgroundColor: event.target.value })}
              />
            </label>
          )}
          {draft.appBackgroundMode === "image" && (
            <label className="field">
              <span>背景画像</span>
              <input type="file" accept="image/*" onChange={(event) => handleImageSettingChange("appBackgroundImage", event)} />
            </label>
          )}
        </section>
        <section className="settings-group">
          <h3>上部バー背景</h3>
          <label className="field">
            <span>モード</span>
            <select
              value={draft.topbarBackgroundMode}
              onChange={(event) => setDraft({ ...draft, topbarBackgroundMode: event.target.value })}
            >
              <option value="theme">テーマ標準</option>
              <option value="solid">単色</option>
              <option value="image">画像</option>
            </select>
          </label>
          {draft.topbarBackgroundMode === "solid" && (
            <label className="field">
              <span>バー背景色</span>
              <input
                type="color"
                value={draft.topbarBackgroundColor || (draftTheme === "dark" ? "#1b1e21" : "#ffffff")}
                onChange={(event) => setDraft({ ...draft, topbarBackgroundColor: event.target.value })}
              />
            </label>
          )}
          {draft.topbarBackgroundMode === "image" && (
            <label className="field">
              <span>バー背景画像</span>
              <input type="file" accept="image/*" onChange={(event) => handleImageSettingChange("topbarBackgroundImage", event)} />
            </label>
          )}
        </section>
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function DrawDialog({ onClose, onSave }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!context) return;
    context.fillStyle = "rgba(0,0,0,0)";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 6;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#ffffff";
  }, []);

  function getPoint(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvasRef.current.width,
      y: ((event.clientY - rect.top) / rect.height) * canvasRef.current.height,
    };
  }

  if (item.type === "draw" && item.imagePath) {
    return (
      <article className="card sticker-card" onContextMenu={(event) => onItemContextMenu(event, item)}>
        <img className="sticker-image" src={item.imagePath} alt={item.title || "Draw sticker"} draggable="false" />
      </article>
    );
  }

  if (item.type === "shape-line") {
    return <article className="card sticker-card sticker-line" onContextMenu={(event) => onItemContextMenu(event, item)} />;
  }

  if (item.type === "shape-rect") {
    return <article className="card sticker-card sticker-rect" onContextMenu={(event) => onItemContextMenu(event, item)} />;
  }

  if (item.type === "shape-circle") {
    return <article className="card sticker-card sticker-circle" onContextMenu={(event) => onItemContextMenu(event, item)} />;
  }

  function startDraw(event) {
    const context = canvasRef.current.getContext("2d");
    const point = getPoint(event);
    drawingRef.current = true;
    context.beginPath();
    context.moveTo(point.x, point.y);
  }

  function moveDraw(event) {
    if (!drawingRef.current) return;
    const context = canvasRef.current.getContext("2d");
    const point = getPoint(event);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function endDraw() {
    drawingRef.current = false;
  }

  return (
    <Dialog onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ imagePath: canvasRef.current.toDataURL("image/png") });
        }}
      >
        <h2>Draw Sticker</h2>
        <canvas
          ref={canvasRef}
          className="draw-canvas"
          width="720"
          height="420"
          onPointerDown={startDraw}
          onPointerMove={moveDraw}
          onPointerUp={endDraw}
          onPointerLeave={endDraw}
        />
        <DialogActions onClose={onClose} />
      </form>
    </Dialog>
  );
}

function Lightbox({ item, hasPrevious, hasNext, onClose, onPrevious, onNext }) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [showChrome, setShowChrome] = useState(true);
  const hideTimerRef = useRef(null);

  function pingChrome() {
    setShowChrome(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowChrome(false), 1400);
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && hasPrevious) onPrevious();
      if (event.key === "ArrowRight" && hasNext) onNext();
      pingChrome();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasNext, hasPrevious, onClose, onNext, onPrevious]);

  useEffect(() => {
    setIsZoomed(false);
    pingChrome();
  }, [item.id]);

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  return (
    <div
      className={`${isZoomed ? "lightbox zoomed" : "lightbox"} ${showChrome ? "chrome-visible" : "chrome-hidden"}`}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onMouseMove={pingChrome}
      onPointerDown={pingChrome}
    >
      <button className="lightbox-close" type="button" onClick={onClose} aria-label="閉じる">
        ×
      </button>
      <button
        className="lightbox-nav lightbox-prev"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          pingChrome();
          onPrevious();
        }}
        disabled={!hasPrevious}
        aria-label="前の画像"
      >
        ‹
      </button>
      <figure
        className="lightbox-figure"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={() => {
          pingChrome();
          setIsZoomed((value) => !value);
        }}
      >
        {item.type === "video" ? (
          <video src={item.imagePath} controls autoPlay />
        ) : (
          <img src={item.imagePath} alt={item.title || "画像"} />
        )}
        <figcaption>
          {item.label && <span className="chip">{item.label}</span>}
          <strong>{item.title || "Untitled"}</strong>
          {item.content && <span>{item.content}</span>}
        </figcaption>
      </figure>
      <button
        className="lightbox-nav lightbox-next"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          pingChrome();
          onNext();
        }}
        disabled={!hasNext}
        aria-label="次の画像"
      >
        ›
      </button>
    </div>
  );
}

