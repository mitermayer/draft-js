/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule convertFromRawToDraftState
 * @format
 * @flow
 */

'use strict';

import type {BlockMap} from 'BlockMap';
import type {BlockNodeConfig} from 'BlockNode';
import type CharacterMetadata from 'CharacterMetadata';
import type {RawDraftContentBlock} from 'RawDraftContentBlock';
import type {RawDraftContentState} from 'RawDraftContentState';

const ContentBlock = require('ContentBlock');
const ContentBlockNode = require('ContentBlockNode');
const ContentState = require('ContentState');
const DraftEntity = require('DraftEntity');
const invariant = require('invariant');
const Immutable = require('immutable');

const createCharacterList = require('createCharacterList');
const decodeEntityRanges = require('decodeEntityRanges');
const decodeInlineStyleRanges = require('decodeInlineStyleRanges');
const generateRandomKey = require('generateRandomKey');

const {List, Map} = Immutable;

const decodeBlockNodeConfig = (
  block: RawDraftContentBlock,
  entityMap: *,
): BlockNodeConfig => {
  const {key, type, data, text, depth} = block;
  return {
    text,
    depth: depth || 0,
    type: type || 'unstyled',
    key: key || generateRandomKey(),
    data: Map(data),
    characterList: decodeCharacterList(block, entityMap),
  };
};

const decodeCharacterList = (
  block: RawDraftContentBlock,
  entityMap: *,
): ?List<CharacterMetadata> => {
  const {
    text,
    entityRanges: rawEntityRanges,
    inlineStyleRanges: rawInlineStyleRanges,
  } = block;

  const entityRanges = rawEntityRanges || [];
  const inlineStyleRanges = rawInlineStyleRanges || [];

  // Translate entity range keys to the DraftEntity map.
  return createCharacterList(
    decodeInlineStyleRanges(text, inlineStyleRanges),
    decodeEntityRanges(
      text,
      entityRanges
        .filter(range => entityMap.hasOwnProperty(range.key))
        .map(range => ({...range, key: entityMap[range.key]})),
    ),
  );
};

const addKeyIfMissing = (block: RawDraftContentBlock): RawDraftContentBlock => {
  return {
    ...block,
    key: block.key || generateRandomKey(),
  };
};

/**
 * Node stack is responsible to ensure we traverse the tree only once
 * in depth order, while also providing parent refs to inner nodes to
 * construct their links.
 */
const updateNodeStack = (
  stack: Array<*>,
  nodes: Array<*>,
  parentRef: ContentBlockNode,
): Array<*> => {
  const decoratedNodes = nodes.map(block => {
    return {
      ...block,
      parentRef,
    };
  });

  // since we pop nodes from the stack we need to insert them in reverse
  return stack.concat(decoratedNodes.reverse());
};

/**
 * This will build a tree draft content state by creating the node
 * reference links into a single tree walk. Each node has a link
 * reference to "parent", "children", "nextSibling" and "prevSibling"
 * blockMap will be created using depth ordering.
 */
const decodeContentBlockNodes = (
  blocks: Array<RawDraftContentBlock>,
  entityMap: *,
): BlockMap => {
  return (
    blocks
      // ensure children have valid keys to enable sibling links
      .map(addKeyIfMissing)
      .reduce((acc: BlockMap, block: RawDraftContentBlock, index: number) => {
        invariant(
          Array.isArray(block.children),
          'invalid RawDraftContentBlock can not be converted to ContentBlockNode',
        );

        // ensure children have valid keys to enable sibling links
        const children = block.children.map(addKeyIfMissing);

        // root level nodes
        const contentBlockNode = new ContentBlockNode({
          ...decodeBlockNodeConfig(block, entityMap),
          prevSibling: index === 0 ? null : blocks[index - 1].key,
          nextSibling:
            index === blocks.length - 1 ? null : blocks[index + 1].key,
          children: List(children.map(child => child.key)),
        });

        // push root node to blockMap
        acc.push(contentBlockNode);

        // this stack is used to ensure we visit all nodes respecting depth ordering
        let stack = updateNodeStack([], children, contentBlockNode);

        // start computing children nodes
        while (stack.length > 0) {
          // we pop from the stack and start processing this node
          const node = stack.pop();

          // parentRef already points to a converted ContentBlockNode
          const parentRef: ContentBlockNode = node.parentRef;
          const siblings = parentRef.getChildKeys();
          const index = siblings.indexOf(node.key);
          const isValidBlock = Array.isArray(node.children);

          if (!isValidBlock) {
            invariant(
              isValidBlock,
              'invalid RawDraftContentBlock can not be converted to ContentBlockNode',
            );
            break;
          }

          // ensure children have valid keys to enable sibling links
          const children = node.children.map(addKeyIfMissing);

          const contentBlockNode = new ContentBlockNode({
            ...decodeBlockNodeConfig(node, entityMap),
            parent: parentRef.getKey(),
            children: List(children.map(child => child.key)),
            prevSibling: index === 0 ? null : siblings.get(index - 1),
            nextSibling:
              index === siblings.size - 1 ? null : siblings.get(index + 1),
          });

          // push node to blockMap
          acc.push(contentBlockNode);

          // this stack is used to ensure we visit all nodes respecting depth ordering
          stack = updateNodeStack(stack, children, contentBlockNode);
        }

        return acc;
      }, [])
  );
};

const decodeContentBlocks = (
  blocks: Array<RawDraftContentBlock>,
  entityMap: *,
): BlockMap => {
  return blocks.map(
    (block: RawDraftContentBlock) =>
      new ContentBlock(decodeBlockNodeConfig(block, entityMap)),
  );
};

const decodeRawBlocks = (
  rawState: RawDraftContentState,
  entityMap: *,
): BlockMap => {
  const rawBlocks = rawState.blocks;

  if (!Array.isArray(rawBlocks[0].children)) {
    return decodeContentBlocks(rawBlocks, entityMap);
  }

  return decodeContentBlockNodes(rawBlocks, entityMap);
};

const decodeRawEntityMap = (rawState: RawDraftContentState): * => {
  const {entityMap: rawEntityMap} = rawState;
  const entityMap = {};

  // TODO: Update this once we completely remove DraftEntity
  Object.keys(rawEntityMap).forEach(rawEntityKey => {
    const {type, mutability, data} = rawEntityMap[rawEntityKey];

    // get the key reference to created entity
    entityMap[rawEntityKey] = DraftEntity.__create(
      type,
      mutability,
      data || {},
    );
  });

  return entityMap;
};

const convertFromRawToDraftState = (
  rawState: RawDraftContentState,
): ContentState => {
  invariant(Array.isArray(rawState.blocks), 'invalid RawDraftContentState');

  // decode entities
  const entityMap = decodeRawEntityMap(rawState);

  // decode blockMap
  const blockMap = decodeRawBlocks(rawState, entityMap);

  return ContentState.createFromBlockArray(blockMap);
};

module.exports = convertFromRawToDraftState;
