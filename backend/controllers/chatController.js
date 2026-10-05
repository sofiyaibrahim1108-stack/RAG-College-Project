import { ragGraph } from "../graph/ragGraph.js";
import { Message } from "../models/Message.js";
import { Conversation } from "../models/Conversation.js";
import { routeDepartment } from "../services/router.js";
import { processTabularQuery, formatTabularTemplateAnswer } from "../services/tabularProcessor.js";
import { generateTextEmbedding } from "../services/embeddingService.js";
import { retrieveWithScopeFallback } from "../services/textRetrieval.js";
import { siglipClient } from "../services/siglipClient.js";
import { retrieveRelevantImages, resolveMultimodalAttachments } from "../services/imageRetrieval.js";
import { buildRAGContext } from "../services/contextBuilder.js";
import {
  streamAnswer,
  FALLBACK_MESSAGE,
  isFallbackAnswer,
  checkEvidenceSupportGate,
  filterSupportingSources,
  verifyAnswerGrounding
} from "../services/llm.js";
import {
  formatSources,
  formatImageCitations
} from "../utils/citations.js";
import { RAG_CONFIG } from "../config/rag.js";
import { normalizeUserQuery } from "../services/queryNormalizer.js";


/**
 * Executes standard RAG query via compiled LangGraph
 */
export async function askQuestion(req, res) {
  try {
    const { question, conversationId } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question cannot be empty"
      });
    }

    console.log(
      `[ChatController] Incoming question: "${question}" (conv: ${
        conversationId || "new"
      })`
    );

    const result = await ragGraph.invoke({
      question: question.trim(),
      conversationId: conversationId || null
    });

    res.json({
      success: true,
      conversationId: result.conversationId,
      answer: result.finalAnswer,
      queryType: result.queryType,
      routedDepartments: result.routedDepartments,
      candidates: result.routerCandidates,
      confidence: result.routerConfidence,
      sources: result.sources,
      images: result.imageCitations,
      fallbackReason: result.fallbackReason || null,
      timings: result.timings
    });
  } catch (error) {
    console.error(
      `[ChatController Error] ${error.stack || error.message}`
    );

    res.status(500).json({
      success: false,
      error: "An unexpected error occurred while processing your request.",
      fallbackAnswer: FALLBACK_MESSAGE
    });
  }
}


/**
 * Server-Sent Events (SSE) streaming endpoint
 *
 * Important:
 * If the router incorrectly classifies a CSV/table question as
 * document_qa, we perform a TABULAR RESCUE after text retrieval.
 *
 * Example:
 *
 * "What is the typical mathematics performance of the students?"
 *
 * Router:
 *   document_qa
 *
 * Retrieval:
 *   finds student_marks_dataset.csv
 *
 * Tabular rescue:
 *   average(Math) = 68.23
 *
 * Then the authoritative tabular result is passed into contextBuilder.
 */
export async function askQuestionStream(req, res) {
  const { question, conversationId } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({
      error: "Question cannot be empty"
    });
  }

  // ------------------------------------------------------------
  // SSE HEADERS
  // ------------------------------------------------------------

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    );
  };

  const timings = {};
  const tTotal = Date.now();

  try {
    // ==========================================================
    // 0. CREATE / LOAD CONVERSATION
    // ==========================================================

    let convId = conversationId;

    if (!convId) {
      const newConv = await Conversation.create({
        title: question.trim().slice(0, 40)
      });

      convId = newConv._id.toString();
    }

    sendEvent("conversationId", {
      conversationId: convId
    });


    // ==========================================================
    // 1. LOAD RECENT HISTORY
    // ==========================================================

    const t0 = Date.now();

    const recentMsgs = await Message.find({
      conversationId: convId
    })
      .sort({ createdAt: -1 })
      .limit(6)
      .lean();

    const history = recentMsgs
      .reverse()
      .map((m) => ({
        role: m.role,
        content: m.content,
        routedDepartments: m.routedDepartments || []
      }));

    timings.history = Date.now() - t0;

    const originalQuestion = question.trim();
    const hasPreviousUserTurns = Array.isArray(history) && history.some((m) => m.role === "user");
    const effectiveQuestion = hasPreviousUserTurns
      ? await normalizeUserQuery(originalQuestion, history)
      : originalQuestion;

    // ==========================================================
    // 2. DEPARTMENT / QUERY ROUTER
    // ==========================================================

    const tRouter = Date.now();

    sendEvent("status", {
      message: "Searching your documents..."
    });

    const routeResult = await routeDepartment(
      effectiveQuestion,
      history
    );

    timings.router = Date.now() - tRouter;

    sendEvent("routed", {
      queryType: routeResult.queryType,
      departments: routeResult.departments,
      candidates: routeResult.candidates,
      confidence: routeResult.confidence,
      duration: timings.router
    });


    // ==========================================================
    // OUT OF SCOPE SHORT-CIRCUIT
    // ==========================================================

    if (routeResult.queryType === "out_of_scope") {
      timings.total = Date.now() - tTotal;
      timings.fallbackReason = "out_of_scope";

      sendEvent("token", {
        token: FALLBACK_MESSAGE
      });

      sendEvent("complete", {
        messageId: null,
        answer: FALLBACK_MESSAGE,
        fallbackReason: "out_of_scope",
        sources: [],
        images: [],
        routedDepartments: [],
        timings
      });

      res.end();
      return;
    }


    // ==========================================================
    // 3. INITIAL QUERY TYPE
    // ==========================================================

    let tabularResult = null;

    let effectiveQueryType = routeResult.queryType;

    let effectiveDepartments = [
      ...(routeResult.departments || [])
    ];


    // ==========================================================
    // 4. NORMAL TABULAR ROUTE
    //
    // If router already correctly identifies tabular,
    // process it immediately.
    // ==========================================================

    if (routeResult.queryType === "tabular") {
      const tTab = Date.now();

      sendEvent("status", {
        message: "Processing tabular calculations..."
      });

      try {
        tabularResult = await processTabularQuery(
          originalQuestion,
          routeResult.departments
        );

        if (
          (!tabularResult ||
            !tabularResult.success ||
            tabularResult.computedValue === null) &&
          effectiveQuestion &&
          effectiveQuestion !== originalQuestion
        ) {
          tabularResult = await processTabularQuery(
            effectiveQuestion,
            routeResult.departments
          );
        }

        timings.tabular = Date.now() - tTab;

        console.log(
          "[ChatController] Initial tabular result:",
          tabularResult
            ? {
                success: tabularResult.success,
                operation: tabularResult.operation,
                column: tabularResult.column,
                computedValue: tabularResult.computedValue
              }
            : null
        );

        if (
          !tabularResult ||
          !tabularResult.success ||
          tabularResult.computedValue === null
        ) {
          console.log(
            "[ChatController] Tabular query unresolved"
          );

          tabularResult = null;

          effectiveQueryType = "document_qa";
          effectiveDepartments = [];
          textChunks = textChunks.filter(
            (c) => !/\.(csv|xlsx?)$/i.test(c.documentName || "")
          );
        }
      } catch (e) {
        console.warn(
          `[Stream Tabular notice] ${e.message}`
        );

        tabularResult = null;

        effectiveQueryType = "document_qa";
        effectiveDepartments = [];
      }
    }


    // ==========================================================
    // 5. TEXT EMBEDDING + TEXT RETRIEVAL
    //
    // We intentionally perform retrieval BEFORE tabular rescue.
    //
    // Why?
    //
    // The router may incorrectly say:
    //
    // document_qa
    //
    // while retrieval can still discover:
    //
    // student_marks_dataset.csv
    //
    // That CSV discovery allows us to invoke the tabular processor.
    // ==========================================================

    const isStrictVisual =
  effectiveQueryType === "visual_qa" &&
  /\b(screenshot|describe\s+only\s+the\s+visual|visual\s+elements|do\s+not\s+use\s+surrounding\s+text)\b/i.test(effectiveQuestion);

    let textChunks = [];
    let sources = [];


    const hasAuthoritativeTabular = tabularResult && tabularResult.success && tabularResult.computedValue !== null;

    if (!isStrictVisual && !hasAuthoritativeTabular) {
      // --------------------------------------------------------
      // TEXT EMBEDDING
      // --------------------------------------------------------

      const tEmb = Date.now();

      const textEmb =
        await generateTextEmbedding(effectiveQuestion);

      timings.textEmbedding =
        Date.now() - tEmb;


      // --------------------------------------------------------
      // TEXT RETRIEVAL
      // --------------------------------------------------------

      const tRet = Date.now();

      const retrieval =
        await retrieveWithScopeFallback(
          textEmb,
          effectiveDepartments,
          5,
          effectiveQuestion
        );

      textChunks = retrieval.chunks || [];

      if (
        retrieval.widened &&
        textChunks.length > 0
      ) {
        effectiveDepartments = [
          ...new Set(
            textChunks
              .map((c) => c.department)
              .filter(Boolean)
          )
        ];
      }

      timings.textRetrieval =
        Date.now() - tRet;

      sources =
        formatSources(textChunks);


      // ========================================================
      // 5A. TABULAR RESCUE
      //
      // IMPORTANT FIX
      //
      // If router says document_qa but retrieval discovers a
      // CSV, give the tabular processor one chance.
      //
      // This fixes:
      //
      // "What is the typical mathematics performance..."
      //
      // where the router currently returns document_qa.
      // ========================================================

      const csvChunks =
        textChunks.filter((chunk) =>
          /\.csv$/i.test(
            chunk.documentName || ""
          )
        );


      const hasCsvEvidence =
        csvChunks.length > 0;


      const shouldAttemptTabularRescue =
        !tabularResult &&
        hasCsvEvidence &&
        effectiveQueryType !== "visual_qa";


      if (shouldAttemptTabularRescue) {
        console.log(
          "[Tabular Rescue] CSV evidence detected:",
          [
            ...new Set(
              csvChunks.map(
                (c) => c.documentName
              )
            )
          ]
        );

        const tTabRescue = Date.now();

        sendEvent("status", {
          message:
            "Analyzing the uploaded table..."
        });


        try {
          /*
           * IMPORTANT:
           *
           * Do NOT force the current PDF department here.
           *
           * The router may have returned:
           *
           * ["College Information"]
           *
           * even though the CSV belongs to another
           * department / scope.
           *
           * Passing [] lets the tabular processor locate
           * the actual table dataset.
           */
          tabularResult =
            await processTabularQuery(
              question,
              []
            );


          timings.tabular =
            Date.now() - tTabRescue;


          console.log(
            "[Tabular Rescue] Result:",
            tabularResult
              ? {
                  success:
                    tabularResult.success,
                  documentName:
                    tabularResult.documentName,
                  operation:
                    tabularResult.operation,
                  column:
                    tabularResult.column,
                  computedValue:
                    tabularResult.computedValue
                }
              : null
          );


          // ----------------------------------------------------
          // SUCCESSFUL TABULAR RESCUE
          // ----------------------------------------------------

          if (
            tabularResult &&
            tabularResult.success &&
            tabularResult.computedValue !== null
          ) {
            console.log(
              "[Tabular Rescue] SUCCESS"
            );

            console.log(
              `[Tabular Rescue] ${tabularResult.operation}(${tabularResult.column}) = ${tabularResult.computedValue}`
            );


            /*
             * This is the critical state change.
             *
             * From this point onward the question is treated
             * as a trusted tabular query.
             */
            effectiveQueryType = "tabular";


            /*
             * The actual tabular document is authoritative.
             *
             * We don't want the PDF department returned by the
             * router to influence the evidence gate.
             */
            if (tabularResult.documentName) {
              const matchingCsv =
                textChunks.find(
                  (chunk) =>
                    chunk.documentName ===
                    tabularResult.documentName
                );

              if (
                matchingCsv?.department
              ) {
                effectiveDepartments = [
                  matchingCsv.department
                ];
              }
            }
          } else {
            console.log(
              "[Tabular Rescue] No valid tabular result. Filtering raw CSV chunks to prevent hallucination."
            );

            textChunks = textChunks.filter(
              (c) => !/\.(csv|xlsx?)$/i.test(c.documentName || "")
            );
            tabularResult = null;
          }
        } catch (e) {
          console.warn(
            `[Tabular Rescue notice] ${e.message}`
          );

          tabularResult = null;
        }
      }
    } else {
      timings.textEmbedding = 0;
      timings.textRetrieval = 0;
    }


    // ==========================================================
    // 6. IMAGE EMBEDDING + IMAGE RETRIEVAL (SigLIP Candidate Signal)
    // ==========================================================

    let images = [];
    let imageCitations = [];
    let siglipCandidates = [];

    if (!hasAuthoritativeTabular) {
      const tSiglip = Date.now();
      try {
        const siglipEmb = await siglipClient.embedText(question);
        timings.siglipEmbedding = Date.now() - tSiglip;

        const tImgRet = Date.now();
        siglipCandidates = await retrieveRelevantImages(
          siglipEmb,
          routeResult.departments,
          3,
          undefined,
          question
        );
        timings.imageRetrieval = Date.now() - tImgRet;
      } catch (e) {
        timings.siglipEmbedding = Date.now() - tSiglip;
        timings.imageRetrieval = 0;
      }
    } else {
      timings.siglipEmbedding = 0;
      timings.imageRetrieval = 0;
    }


    // ==========================================================
    // 7. BUILD RAG CONTEXT
    // ==========================================================

    const tCtx = Date.now();

    const context =
      buildRAGContext(
        textChunks,
        images,
        tabularResult,
        question
      );

    timings.contextBuilder =
      Date.now() - tCtx;


    // ==========================================================
    // DEBUG
    // ==========================================================

    console.log(
      "\n========== CHAT CONTROLLER DEBUG =========="
    );

    console.log(
      "Question:",
      question
    );

    console.log(
      "Router query type:",
      routeResult.queryType
    );

    console.log(
      "Effective query type:",
      effectiveQueryType
    );

    console.log(
      "CSV evidence:",
      textChunks
        .filter((c) =>
          /\.csv$/i.test(
            c.documentName || ""
          )
        )
        .map((c) => c.documentName)
    );

    console.log(
      "Tabular result:",
      tabularResult
        ? {
            success:
              tabularResult.success,
            operation:
              tabularResult.operation,
            column:
              tabularResult.column,
            computedValue:
              tabularResult.computedValue
          }
        : null
    );

    console.log(
      "Context has tabular:",
      /TABULAR TOOL RESULT/i.test(
        context.contextPrompt || ""
      )
    );

    console.log(
      "===========================================\n"
    );


    // ==========================================================
    // 8. EVIDENCE + LLM
    // ==========================================================

    let fullAnswer = "";

    let finalSources = sources;

    let finalImageCitations =
      imageCitations;

    let fallbackReason = null;


    // ----------------------------------------------------------
    // Evidence metadata
    // ----------------------------------------------------------

    const evidenceMeta = {
      topSimilarity: Math.max(
        0,
        ...textChunks.map(
          (c) => c.similarity || 0
        )
      )
    };


    // ----------------------------------------------------------
    // IMPORTANT FIX:
    //
    // If tabularResult is successful, the authoritative
    // calculation itself is sufficient evidence.
    //
    // Therefore DO NOT run the normal lexical evidence gate.
    //
    // This prevents:
    //
    // typical -> missing_attribute
    //
    // ----------------------------------------------------------

    let gate;


    if (
      tabularResult &&
      tabularResult.success &&
      tabularResult.computedValue !== null
    ) {
      gate = {
        supported: true,
        reason:
          "tabular_tool_result_present"
      };

      console.log(
        "[Evidence Gate] Tabular result present -> automatically supported"
      );
    } else {
      gate =
        checkEvidenceSupportGate(
          question,
          context.contextPrompt,
          effectiveQueryType,
          evidenceMeta
        );
    }


    // ==========================================================
    // 9. EVIDENCE REJECTED
    // ==========================================================

    if (!gate.supported) {
      console.log(
        `[Evidence Gate Stream] Question "${question}" rejected: ${gate.reason}. Skipping LLM stream.`
      );

      fullAnswer =
        FALLBACK_MESSAGE;

      fallbackReason =
        gate.reason;

      effectiveDepartments = [];

      sendEvent("token", {
        token: fullAnswer
      });

      timings.llm = 0;

      finalSources = [];

      finalImageCitations = [];
    }


    // ==========================================================
    // 10. LLM STREAM
    // ==========================================================

    else {
      sendEvent("status", {
        message:
          "Generating grounded response..."
      });

      const tLLM = Date.now();
      const meta = {};

      // ========================================================
      // Task 1b: Tabular Template Answer with zero LLM calls
      // ========================================================
      const tool =
        tabularResult &&
        tabularResult.success &&
        tabularResult.computedValue !== null &&
        tabularResult.operation !== "preview"
          ? tabularResult
          : null;

      if (tool) {
        const templateAnswer = formatTabularTemplateAnswer(tool, effectiveQuestion);
        const grounding = validateNumericalGrounding(templateAnswer, tool.summary || context.contextPrompt);
        if (grounding.valid) {
          timings.llm = 0;
          fullAnswer = templateAnswer;
          sendEvent("token", { token: fullAnswer });
        }
      }

      if (!fullAnswer) {
        fullAnswer =
          await streamAnswer(
            effectiveQuestion,
            context.contextPrompt,
            history,
            (token) => {
              sendEvent("token", {
                token
              });
            },
            effectiveQueryType,
            evidenceMeta,
            meta
          );

        timings.llm =
          Date.now() - tLLM;
      }


      // ========================================================
      // LLM FALLBACK
      // ========================================================

      if (isFallbackAnswer(fullAnswer)) {
        fullAnswer =
          FALLBACK_MESSAGE;

        fallbackReason =
          meta.reason ||
          "insufficient_evidence";

        finalSources = [];

        finalImageCitations = [];

        effectiveDepartments = [];
      }


      // ========================================================
      // TABULAR SOURCES
      // ========================================================

      else if (tool) {
        console.log(
          "[ChatController] Final answer is tabular."
        );

        const matchingCsv = (textChunks || []).find((c) => c.documentName === tool.documentName);
        effectiveDepartments = matchingCsv?.department
          ? [matchingCsv.department]
          : (routeResult.departments && routeResult.departments.length > 0 ? routeResult.departments : ["Student information"]);

        /*
         * Only cite the actual dataset used by the
         * deterministic tabular processor.
         */

        const fromDataset =
          (sources || []).filter(
            (s) =>
              s.documentName ===
              tool.documentName
          );


        finalSources =
          fromDataset.length > 0
            ? fromDataset.slice(0, 1)
            : [
                {
                  documentName:
                    tool.documentName,
                  pageNumber: 1,
                  chunkIndex: 0,
                  snippet:
                    tool.summary?.slice(
                      0,
                      200
                    )
                }
              ];


        finalImageCitations = [];
      }


      // ========================================================
      // NORMAL DOCUMENT SOURCES WITH SHARED MULTIMODAL ATTACHMENT
      // ========================================================

      else {
        finalSources =
          filterSupportingSources(
            sources,
            fullAnswer,
            textChunks,
            question
          );

        finalImageCitations = await resolveMultimodalAttachments({
          survivingSources: finalSources,
          retrievedChunks: textChunks,
          maxImages: RAG_CONFIG.topKImages,
          isFallback: false,
          question: originalQuestion,
          finalAnswer: fullAnswer
        });

        const sourceDepts = [...new Set((finalSources || []).map((s) => s.department).filter(Boolean))];
        const chunkDepts = [...new Set((textChunks || []).map((c) => c.department).filter(Boolean))];

        if (routeResult.departments && routeResult.departments.length > 0) {
          effectiveDepartments = routeResult.departments;
        } else {
          effectiveDepartments = sourceDepts.length > 0 ? sourceDepts : chunkDepts;
        }
      }
    }


    // ==========================================================
    // 11. FINAL TIMINGS
    // ==========================================================

    timings.total =
      Date.now() - tTotal;

    timings.fallbackReason =
      fallbackReason;


    // ==========================================================
    // 12. SAVE USER MESSAGE
    // ==========================================================

    await Message.create({
      conversationId: convId,
      role: "user",
      content: originalQuestion
    });


    // ==========================================================
    // 13. SAVE ASSISTANT MESSAGE
    // ==========================================================

    const assistantMsg =
      await Message.create({
        conversationId: convId,
        role: "assistant",
        content: fullAnswer,
        routedDepartments:
          effectiveDepartments,
        sources: finalSources,
        images:
          finalImageCitations,
        timings
      });


    // ==========================================================
    // 14. UPDATE CONVERSATION
    // ==========================================================

    await Conversation.findByIdAndUpdate(
      convId,
      {
        updatedAt: new Date()
      }
    );


    // ==========================================================
    // 15. SEND COMPLETE SSE EVENT
    // ==========================================================

    sendEvent("complete", {
      messageId:
        assistantMsg._id,
      answer: fullAnswer,
      fallbackReason,
      sources: finalSources,
      images:
        finalImageCitations,
      routedDepartments: effectiveDepartments,
      timings
    });


    res.end();
  } catch (error) {
    console.error(
      `[askQuestionStream error] ${
        error.stack ||
        error.message
      }`
    );

    try {
      sendEvent("error", {
        message:
          "An unexpected error occurred while processing your request."
      });
    } catch (_) {
      // Ignore SSE write errors during connection failure.
    }

    res.end();
  }
}


/**
 * Message feedback handler
 */
export async function submitFeedback(
  req,
  res
) {
  try {
    const { messageId } =
      req.params;

    const { feedback } =
      req.body;


    if (
      ![
        "like",
        "dislike",
        null
      ].includes(feedback)
    ) {
      return res.status(400).json({
        error:
          "Invalid feedback value"
      });
    }


    const message =
      await Message.findByIdAndUpdate(
        messageId,
        {
          feedback
        },
        {
          new: true
        }
      );


    if (!message) {
      return res.status(404).json({
        error:
          "Message not found"
      });
    }


    res.json({
      success: true,
      message
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}