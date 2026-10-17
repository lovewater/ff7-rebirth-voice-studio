import os
import time
import traceback
import subprocess
import json
from typing import Dict, Any
import tempfile
import uuid

from base.path_utils import ensure_project_paths
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse

ensure_project_paths()

from base.reporter import Reporter
from base.api_base import TTSInput, TTSResponse, TTSResponseOutput, VectorPredictInput
from audio_cache.manager import AudioCacheManager
from base.config_manager import ConfigManager
from base.utils import convert_audio_format, logger
from base.ttsmanager import TTSManager
from base.vector_utils import VectorSerializer

# 创建路由器
routes = APIRouter()


@routes.post("/predict")
def predict(input_data: TTSInput) -> Dict[str, Any]:
    """
    TTS推理接口
    """
    start_time = time.time()

    reporter = Reporter()

    # 初始化响应对象
    response = TTSResponse(
        input=input_data.model_dump(),
        output=TTSResponseOutput()
    )
    reporter.reportProgress(input_data.task_id,10)
    try:
        # 获取音频缓存管理器
        cache_manager = AudioCacheManager.get_instance()

        # 处理样本音频（缓存或从缓存中取出）
        logger.info("开始处理样本音频...")

        # 如果用户没有提供样本音频，使用默认音频
        sample_audio_input = input_data.sample_audio
        if not sample_audio_input:
            default_audio_path = os.path.join(os.path.dirname(__file__), 'samples', 'default.wav')
            if os.path.exists(default_audio_path):
                sample_audio_input = default_audio_path
                logger.info("用户未提供样本音频，使用默认音频: samples/default.wav")
            else:
                logger.warning("默认音频文件不存在: samples/default.wav")

        sample_cache_item = cache_manager.process_sample_audio(
            sample_audio=sample_audio_input,
            sample_text=""
        )
        logger.info("样本音频处理完成")


        # 处理情感参考音频（如果提供）
        emo_cache_item = None
        if input_data.emo_ref_audio:
            logger.info("开始处理情感参考音频...")
            emo_cache_item = cache_manager.process_sample_audio(
                sample_audio=input_data.emo_ref_audio,
                sample_text=""
            )
            logger.info("情感参考音频处理完成")




        # 使用 TTSManager 的线程锁进行推理
        manager = TTSManager.get_instance()

        try:
            # 获取（或初始化）默认推理实例
            infer_instance = manager.get_infer("default")

            # 创建临时文件保存样本音频
            config_manager = ConfigManager()
            tmp_folder_config = config_manager.get_tmp_folder_config()
            tmp_dir = tmp_folder_config.get("path", "./tmp_files")

            if not os.path.exists(tmp_dir):
                os.makedirs(tmp_dir, exist_ok=True)

            # 保存样本音频到临时文件
            sample_filename = f"sample_{uuid.uuid4().hex}.wav"
            sample_path = os.path.join(tmp_dir, sample_filename)
            with open(sample_path, 'wb') as f:
                f.write(sample_cache_item.data)

            # 保存情感参考音频到临时文件（如果有）
            emo_path = None
            if emo_cache_item:
                emo_filename = f"emo_{uuid.uuid4().hex}.wav"
                emo_path = os.path.join(tmp_dir, emo_filename)
                with open(emo_path, 'wb') as f:
                    f.write(emo_cache_item.data)

            # 生成输出文件路径（IndexTTS2总是输出wav格式）
            wav_filename = f"tts_{uuid.uuid4().hex}.wav"
            wav_path = os.path.join(tmp_dir, wav_filename)

            # 执行推理
            calc_start_time = time.time()

            # 尝试从prepare缓存获取结果（如果启用缓存）
            prepare_result = None
            cache_key = None

            if input_data.enable_cache:
                cache_key, prepare_result = cache_manager.get_prepare_result(
                    sample_item=sample_cache_item,
                    emo_item=emo_cache_item,
                    emo_text=input_data.emo_ref_text,
                    target_device="cuda"
                )

            total_wait_time = 0
            if prepare_result is not None:
                logger.info("从prepare缓存中获取到结果")
            else:
                logger.info("prepare缓存未命中或已禁用，开始执行prepare...")
                wait_time, prepare_result = infer_instance.perpare(
                    spk_audio_prompt=sample_path,
                    emo_audio_prompt=emo_path,
                    emo_alpha=1.0,
                    emo_vector=None,
                    emo_text=input_data.emo_ref_text,
                    use_random=False,
                )
                total_wait_time += wait_time

                # 将prepare结果添加到缓存（如果启用缓存）
                if input_data.enable_cache:
                    cache_key = cache_manager.add_prepare_result(
                        sample_item=sample_cache_item,
                        emo_item=emo_cache_item,
                        emo_text=input_data.emo_ref_text,
                        prepare_result=prepare_result
                    )
                    logger.info("prepare结果已添加到缓存")
            segments = infer_instance.generatesegments(input_data.text)
            available_workers = manager.available_infer_count()
            logger.info(f"当前可用推理单元: {available_workers}")
            logger.info(f"并发推理可用设备数量: {manager.available_infer_count()}")
            wav_results = {}
            pending_tasks = []
            per_seg_progress = (90 - 20) / len(segments) if segments else 0
            finished_count = 0

            for seg_idx, sent in enumerate(segments):
                tmp_rst = None

                # 尝试从TTS缓存获取结果（如果启用缓存）
                if input_data.enable_cache and cache_key:
                    tmp_rst = cache_manager.get_tts_result(cache_key, sent)

                if tmp_rst is not None:
                    logger.info("从tts缓存中获取到结果")
                    wav_results[seg_idx] = tmp_rst
                    finished_count += 1
                    reporter.reportProgress(input_data.task_id, int(20 + per_seg_progress * finished_count))
                else:
                    logger.info("tts缓存未命中或已禁用，加入推理队列...")
                    task = manager.submit_task(sent, prepare_result)
                    pending_tasks.append((seg_idx, task))

            # 等待队列中的任务完成（最多5分钟）
            deadline = time.time() + 300
            failures = {}
            while pending_tasks and time.time() < deadline:
                completed = []
                for seg_idx, task in list(pending_tasks):
                    remaining = max(0, deadline - time.time())
                    # 短等待，避免阻塞其他任务
                    if task.wait(timeout=min(0.5, remaining)):
                        completed.append((seg_idx, task))

                if not completed:
                    time.sleep(0.05)
                    continue

                for seg_idx, task in completed:
                    pending_tasks.remove((seg_idx, task))
                    if task.result is not None:
                        wav_results[seg_idx] = task.result
                        total_wait_time += task.wait_time
                        if input_data.enable_cache and cache_key:
                            cache_manager.add_tts_result(cache_key, segments[seg_idx], task.result)
                        finished_count += 1
                        reporter.reportProgress(input_data.task_id, int(20 + per_seg_progress * finished_count))
                    else:
                        failures[seg_idx] = task.error

            # 超时未完成的任务标记失败并取消
            if pending_tasks:
                for seg_idx, task in pending_tasks:
                    task.cancel()
                    failures[seg_idx] = TimeoutError("任务超时未完成")

            if failures:
                logger.warning(f"部分segment生成失败，失败段索引: {list(failures.keys())}")

            if not wav_results:
                raise RuntimeError("全部segment生成失败")

            # 按顺序合并成功的结果
            wavList = [wav_results[idx] for idx in sorted(wav_results.keys())]
            result_path = infer_instance.toWav(wavList, wav_path, interval_silence=200)

            calc_time = time.time() - calc_start_time - total_wait_time

            # 如果用户请求的格式不是wav，需要进行格式转换
            final_filename = f"tts_{uuid.uuid4().hex}.{input_data.format}"
            final_path = os.path.join(tmp_dir, final_filename)

            if input_data.format.lower() != 'wav':
                # 进行格式转换
                if convert_audio_format(result_path, final_path, input_data.format.lower()):
                    # 转换成功，使用转换后的文件
                    output_filename = final_filename
                    output_path = final_path
                    # 删除原始wav文件
                    try:
                        if os.path.exists(result_path):
                            os.remove(result_path)
                    except Exception as e:
                        logger.warning(f"删除临时wav文件失败: {e}")
                else:
                    # 转换失败，使用原始wav文件
                    logger.warning(f"音频格式转换失败，使用原始wav格式")
                    output_filename = wav_filename
                    output_path = result_path
            else:
                # 用户请求wav格式，直接使用
                output_filename = wav_filename
                output_path = result_path

            # 读取最终的音频文件
            with open(output_path, 'rb') as f:
                audio_data = f.read()

            # 清理临时样本文件
            try:
                if os.path.exists(sample_path):
                    os.remove(sample_path)
                if emo_path and os.path.exists(emo_path):
                    os.remove(emo_path)
            except Exception as e:
                logger.warning(f"清理临时文件失败: {e}")

            # 更新响应
            response.output.calc_time = calc_time
            response.output.audio_size = len(audio_data)
            response.output.s3_url = f"/audio/{output_filename}"
            response.output.success = True
            response.output.message = "Success!"

            logger.info(f"TTS推理完成，耗时: {calc_time:.2f}秒")

        except Exception as e:
            logger.error(f"TTS推理失败: {e}")
            logger.error(traceback.format_exc())
            response.output.success = False
            response.output.message = f"TTS推理失败: {str(e)}"

        # 计算总时间
        total_time = time.time() - start_time
        response.output.wait_time = total_time - response.output.calc_time

        logger.info(f"请求处理完成，总耗时: {total_time:.2f}秒")

    except Exception as e:
        logger.error(f"处理请求失败: {e}")
        logger.error(traceback.format_exc())
        response.output.success = False
        response.output.message = f"处理请求失败: {str(e)}"
    finally:
        reporter.reportResult(input_data.task_id, response.output.model_dump())
    # 返回响应的字典形式
    return response.toDict()


@routes.get("/predict")
def predict_test() -> Dict[str, Any]:
    """
    TTS功能测试接口

    使用默认参数进行TTS测试，不使用任何缓存，测试模型是否正常工作
    """
    # 创建测试用的输入数据
    test_input = TTSInput(
        task_id=f"test_{uuid.uuid4().hex[:8]}",
        text="这是一段用于测试tts模型是否正常工作的音频",
        sample_audio="",  # 使用默认音频
        format="wav",
        vip=0,
        save_file=True,
        speed=1.0,
        emo_ref_audio="",
        emo_ref_text="",
        enable_cache=False  # 禁用所有缓存
    )

    logger.info("开始执行TTS功能测试...")

    # 调用POST版本的predict函数
    result = predict(test_input)

    # 在结果中添加测试标识
    if isinstance(result, dict):
        result["test_mode"] = True
        result["test_description"] = "TTS功能测试 - 禁用缓存模式"

    logger.info("TTS功能测试完成")
    return result

@routes.get("/audio/{filename}")
def get_audio(filename: str):
    """
    获取生成的音频文件
    """
    try:
        # 获取临时文件夹配置
        config_manager = ConfigManager()
        tmp_folder_config = config_manager.get_tmp_folder_config()
        tmp_dir = tmp_folder_config.get("path", "./tmp_files")

        # 构建文件路径
        file_path = os.path.join(tmp_dir, filename)

        # 检查文件是否存在
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="音频文件不存在")

        # 检查文件扩展名以确定媒体类型
        if filename.lower().endswith('.mp3'):
            media_type = "audio/mpeg"
        elif filename.lower().endswith('.wav'):
            media_type = "audio/wav"
        else:
            media_type = "application/octet-stream"

        # 返回文件
        return FileResponse(
            path=file_path,
            media_type=media_type,
            filename=filename
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取音频文件失败: {e}")
        raise HTTPException(status_code=500, detail=f"获取音频文件失败: {str(e)}")


@routes.post("/predict_vector")
def predict_vector(input_data: VectorPredictInput) -> Response:
    """
    向量TTS推理接口

    接受prepare结果向量和segment向量，直接返回wav向量的二进制数据
    """
    try:
        # 反序列化输入向量
        logger.info("开始反序列化输入向量...")
        prepare_result = VectorSerializer.deserialize_from_base64(input_data.prepare_result_b64)
        segment_tokens = VectorSerializer.deserialize_from_base64(input_data.segment_tokens)

        # 移动向量到CUDA设备
        prepare_result = VectorSerializer.move_to_device(prepare_result, "cuda")
        segment_tokens = VectorSerializer.move_to_device(segment_tokens, "cuda")

        logger.info("向量反序列化完成，开始推理...")

        # 使用 TTSManager 的线程锁进行推理
        manager = TTSManager.get_instance()
        lock = manager.get_lock("default")

        with lock:
            # 获取推理实例
            infer_instance = manager.get_infer("default")

            # 执行推理
            calc_start_time = time.time()

            # 调用forward方法进行推理
            wav_tensor = infer_instance.forward(
                segment_tokens,
                *prepare_result
            )

            calc_time = time.time() - calc_start_time
            logger.info(f"向量TTS推理完成，耗时: {calc_time:.2f}秒")

            # 序列化为二进制数据
            wav_vector_bytes = VectorSerializer.serialize_to_bytes(wav_tensor)

            # 直接返回二进制数据，在header中包含计算时间
            return Response(
                content=wav_vector_bytes,
                media_type="application/octet-stream",
                headers={"X-Calc-Time": f"{calc_time:.1f}"}
            )

    except Exception as e:
        logger.error(f"向量TTS推理失败: {e}")
        error_traceback = traceback.format_exc()
        logger.error(error_traceback)

        # 返回JSON格式的错误信息
        error_response = {
            "error": str(e),
            "traceback": error_traceback
        }

        return Response(
            content=json.dumps(error_response, ensure_ascii=False),
            status_code=500,
            media_type="application/json"
        )
